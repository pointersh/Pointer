import { ChildProcess, execFile, spawn } from "child_process"
import { existsSync } from "fs"
import {
commands,
Diagnostic,
DiagnosticSeverity,
languages,
Location,
LocationLink,
Position,
Range, Uri,
window,
workspace,
WorkspaceEdit
} from "vscode"

import {
POINTER_COMMAND_NAME
} from "../../common/constants"
import { logger } from "../../common/logger"
import type { ChatEditOutcome } from "../edit/service"
import { stripAnsi, tailOutput } from "../terminal/output"
import { EditorDiagnostic, EditorLocation, EditorSink, FileOpsSink } from "../tools/more"
import { WorkspaceView } from "../tools/view"
import { CommandOutcome, CommandSink, EditOutcome, EditSink } from "../tools/workspace"

import { allowTool } from "./approvals"

const COMMAND_TIMEOUT_MS = 120_000
const OUTPUT_TAIL = { maxChars: 4000, maxLines: 80 }
const MAX_CAPTURE_CHARS = 200_000

const applyAndSave = async (edit: WorkspaceEdit): Promise<boolean> => {
  if (!(await workspace.applyEdit(edit))) return false
  for (const [uri] of edit.entries()) {
    const document = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
    if (document?.isDirty) await document.save()
  }
  return true
}

const editorCommand = async (fallback: string, command: string, ...args: unknown[]): Promise<EditOutcome> =>
  (await commands.executeCommand<ChatEditOutcome>(command, ...args)) ?? { ok: false, message: fallback }

export const editorEdits = (view: WorkspaceView): EditSink & FileOpsSink => ({
  edit: (file, replacement) =>
    editorCommand("Not changed: the editor did not answer.", POINTER_COMMAND_NAME.chatFileEdit, { file, ...replacement }),
  create: (file, content) =>
    editorCommand("Not created: the editor did not answer.", POINTER_COMMAND_NAME.chatFileCreate, file, content),
  async remove(file) {
    const relative = view.relative(file)
    if (!(await allowTool("delete_file", `delete ${relative}`))) return { ok: false, message: `The user did not allow deleting ${relative}.` }
    const edit = new WorkspaceEdit()
    edit.deleteFile(Uri.file(file), { ignoreIfNotExists: false })
    return (await workspace.applyEdit(edit))
      ? { ok: true, message: `Deleted ${relative}.` }
      : { ok: false, message: `The editor refused to delete ${relative}.` }
  },
  async move(from, to) {
    const [source, target] = [view.relative(from), view.relative(to)]
    if (!(await allowTool("move_file", `move ${source} to ${target}`))) return { ok: false, message: `The user did not allow moving ${source}.` }
    const edit = new WorkspaceEdit()
    edit.renameFile(Uri.file(from), Uri.file(to), { overwrite: false })
    return (await applyAndSave(edit))
      ? { ok: true, message: `Moved ${source} to ${target}.` }
      : { ok: false, message: `The editor refused to move ${source}.` }
  }
})

const DIAGNOSTICS_WAIT_MS = 1500
const DIAGNOSTICS_QUIET_MS = 400
const DIAGNOSTICS_MAX_MS = 4000
const MAX_SELECTION_CHARS = 4000
const MAX_PLACES = 200

const SEVERITY: Record<DiagnosticSeverity, EditorDiagnostic["severity"]> = {
  [DiagnosticSeverity.Error]: "error",
  [DiagnosticSeverity.Warning]: "warning",
  [DiagnosticSeverity.Information]: "info",
  [DiagnosticSeverity.Hint]: "info"
}

const settledDiagnostics = (uri: Uri, quietMs = DIAGNOSTICS_QUIET_MS) =>
  new Promise<void>((resolve) => {
    let quiet: NodeJS.Timeout | undefined
    const finish = () => {
      clearTimeout(first)
      clearTimeout(quiet)
      clearTimeout(longest)
      listener.dispose()
      resolve()
    }
    const first = setTimeout(finish, DIAGNOSTICS_WAIT_MS)
    const longest = setTimeout(finish, DIAGNOSTICS_MAX_MS)
    const listener = languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((changed) => changed.toString() === uri.toString())) return
      clearTimeout(first)
      clearTimeout(quiet)
      quiet = setTimeout(finish, quietMs)
    })
  })

const toLocations = (found: Array<Location | LocationLink> | undefined): EditorLocation[] =>
  (found ?? []).slice(0, MAX_PLACES).map((item) => {
    const [uri, range] =
      "targetUri" in item ? [item.targetUri, item.targetSelectionRange ?? item.targetRange] : [item.uri, item.range]
    return { file: uri.fsPath, line: range.start.line + 1 }
  })

const toDiagnostic = (uri: Uri, diagnostic: Diagnostic): EditorDiagnostic => ({
  file: uri.fsPath,
  line: diagnostic.range.start.line + 1,
  severity: SEVERITY[diagnostic.severity],
  message: diagnostic.message.split("\n")[0],
  source: diagnostic.source
})

export const editorKnowledge = (view: WorkspaceView): EditorSink => ({
  async diagnostics(file) {
    if (file) {
      const uri = Uri.file(file)
      const settled = settledDiagnostics(uri)
      await workspace.openTextDocument(uri)
      await settled
      return languages.getDiagnostics(uri).map((d) => toDiagnostic(uri, d))
    }
    return languages
      .getDiagnostics()
      .filter(([uri]) => uri.scheme === "file" && view.visible(uri.fsPath))
      .flatMap(([uri, found]) => found.map((d) => toDiagnostic(uri, d)))
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
  },
  async references(file, line, character) {
    return toLocations(
      await commands.executeCommand<Location[]>(
        "vscode.executeReferenceProvider",
        Uri.file(file),
        new Position(line, character)
      )
    )
  },
  async definition(file, line, character) {
    return toLocations(
      await commands.executeCommand<Array<Location | LocationLink>>(
        "vscode.executeDefinitionProvider",
        Uri.file(file),
        new Position(line, character)
      )
    )
  },
  async rename(file, line, character, newName) {
    if (!(await allowTool("rename_symbol", `rename a symbol in ${view.relative(file)} to ${newName}`))) {
      return { ok: false, message: "The user did not allow the rename." }
    }
    let edit: WorkspaceEdit | undefined
    try {
      edit = await commands.executeCommand<WorkspaceEdit>(
        "vscode.executeDocumentRenameProvider",
        Uri.file(file),
        new Position(line, character),
        newName
      )
    } catch (error) {
      return {
        ok: false,
        message: `The language server could not rename it: ${error instanceof Error ? error.message : error}`
      }
    }
    if (!edit || !edit.size) {
      return {
        ok: false,
        message: "The language server has no rename here; edit the uses with edit_file instead."
      }
    }
    const beyond = edit.entries().find(([uri]) => uri.scheme !== "file" || !view.visible(uri.fsPath))
    if (beyond) {
      return {
        ok: false,
        message: `Not renamed: it would change ${beyond[0].fsPath}, which is outside the workspace or ignored.`
      }
    }
    const files = edit.entries().map(([uri]) => view.relative(uri.fsPath))
    const changes = edit.entries().reduce((n, [, edits]) => n + edits.length, 0)
    return (await applyAndSave(edit))
      ? {
          ok: true,
          files,
          message: `Renamed to ${newName}: ${changes} changes in ${files.join(", ")}, saved.`
        }
      : { ok: false, message: "The editor refused the rename." }
  },
  async context() {
    const editor = window.activeTextEditor
    const selection = editor && !editor.selection.isEmpty ? editor.selection : undefined
    const text = selection ? editor!.document.getText(new Range(selection.start, selection.end)) : ""
    return {
      activeFile: editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined,
      cursorLine: editor ? editor.selection.active.line + 1 : undefined,
      selection: selection
        ? {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
            text: text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}\n… (cut)` : text
          }
        : undefined,
      openFiles: window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => (tab.input as { uri?: Uri } | undefined)?.uri)
        .filter((uri): uri is Uri => uri?.scheme === "file")
        .map((uri) => uri.fsPath)
    }
  }
})

const BACKGROUND_SHELL: string | boolean = process.platform !== "win32" && existsSync("/bin/bash") ? "/bin/bash" : true

const EXIT_GRACE_MS = 500
const KILL_AFTER_MS = 2000

const killTree = (child: ChildProcess, group: boolean, signal: NodeJS.Signals = "SIGTERM") => {
  try {
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error) child.kill()
      })
    } else if (group && child.pid) {
      process.kill(-child.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch {
    if (child.exitCode === null) child.kill(signal)
  }
}

const runInBackground = (
  command: string,
  cwd: string,
  signal?: AbortSignal
): Promise<CommandOutcome> =>
  new Promise((resolve) => {
    const group = process.platform !== "win32"
    const child = spawn(command, {
      cwd,
      shell: BACKGROUND_SHELL,
      detached: group,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1" }
    })
    let output = ""
    let ended: "stopped" | undefined
    let settled = false
    let leftovers = false
    let exitCode: number | undefined
    const timers: ReturnType<typeof setTimeout>[] = []
    const take = (chunk: string) => {
      output = (output + chunk).slice(-MAX_CAPTURE_CHARS)
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", take)
    child.stderr?.on("data", take)
    const finish = () => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      signal?.removeEventListener("abort", stop)
      if (leftovers || ended) killTree(child, group, "SIGKILL")
      const note = leftovers && !ended ? "\n(it left processes running in the background; they were ended with it)" : ""
      const tail = tailOutput(stripAnsi(output), OUTPUT_TAIL) + note
      resolve(ended ? { ran: true, output: tail, timedOut: ended } : { ran: true, output: tail, exitCode })
    }
    function stop() {
      if (ended || settled) return
      ended = "stopped"
      killTree(child, group)
      timers.push(setTimeout(() => killTree(child, group, "SIGKILL"), KILL_AFTER_MS))
      timers.push(setTimeout(finish, KILL_AFTER_MS + EXIT_GRACE_MS))
    }
    timers.push(setTimeout(stop, COMMAND_TIMEOUT_MS))
    if (signal?.aborted) stop()
    else signal?.addEventListener("abort", stop, { once: true })
    child.on("error", (error) => {
      output += `\n${error.message}`
      exitCode = 127
      finish()
    })
    child.on("exit", (code) => {
      exitCode = code ?? undefined
      timers.push(
        setTimeout(() => {
          leftovers = true
          finish()
        }, EXIT_GRACE_MS)
      )
    })
    child.on("close", () => finish())
  })

export const terminalCommands = (cwd: string): CommandSink => ({
  async run(command, signal) {
    if (signal?.aborted) return { ran: false, output: "" }
    if (!(await allowTool("run_command", `run: ${command}`))) return { ran: false, output: "The user did not allow this command." }
    logger.info(`Chat command: ${command}`)
    return runInBackground(command, cwd, signal)
  }
})
