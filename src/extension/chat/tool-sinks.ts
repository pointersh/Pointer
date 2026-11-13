import { ChildProcess, execFile, spawn } from "child_process"
import { existsSync } from "fs"
import path from "path"
import {
commands,
Diagnostic,
DiagnosticSeverity,
languages,
Location,
LocationLink,
Position,
Range,
Terminal,
TerminalShellIntegration,
Uri,
window,
workspace,
WorkspaceEdit
} from "vscode"

import {
POINTER,
POINTER_COMMAND_NAME
} from "../../common/constants"
import { logger } from "../../common/logger"
import type { ChatEditMode, ChatEditOutcome } from "../edit/service"
import { stripAnsi, tailOutput } from "../terminal/output"
import type { Replacement } from "../tools/edit"
import { isProtectedPath } from "../tools/helpers"
import { EditorDiagnostic, EditorLocation, EditorSink, FileOpsSink } from "../tools/more"
import { WorkspaceView } from "../tools/view"
import { CommandOutcome, CommandSink, EditOutcome, EditSink } from "../tools/workspace"

import { changesBetween, MAX_COMMAND_CHANGES, snapshotTree, TreeSnapshot } from "./command-snapshot"
import type { ReplyChanges } from "./reply-changes"

export type ChatCommandMode = "ask" | "allow" | "off"
export type ChatCommandPlace = "background" | "terminal"

const COMMAND_TIMEOUT_MS = 120_000
const INTEGRATION_WAIT_MS = 4000
const OUTPUT_TAIL = { maxChars: 4000, maxLines: 80 }
const MAX_CAPTURE_CHARS = 200_000

export type ApproveChange = (detail: string, approval: "command" | "change") => Promise<boolean>

export const openDocumentText = async (file: string): Promise<string | undefined> =>
  workspace.textDocuments.find((document) => document.uri.scheme === "file" && document.uri.fsPath === file)?.getText()

const applyAndSave = async (edit: WorkspaceEdit): Promise<boolean> => {
  if (!(await workspace.applyEdit(edit))) return false
  for (const [uri] of edit.entries()) {
    const document = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
    if (document?.isDirty) await document.save()
  }
  return true
}

const gitSays = (cwd: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (error) => resolve(!error))
  })

const gitTag = (cwd: string, file: string) =>
  new Promise<string>((resolve) => {
    execFile("git", ["ls-files", "-v", "--", file], { cwd, timeout: 5000 }, (error, stdout) =>
      resolve(error ? "" : stdout.charAt(0))
    )
  })

const recoverableFromGit = async (file: string): Promise<boolean> => {
  if (workspace.textDocuments.some((d) => d.uri.scheme === "file" && d.uri.fsPath === file && d.isDirty)) return false
  const cwd = path.dirname(file)
  return (
    (await gitSays(cwd, ["ls-files", "--error-unmatch", "--", file])) &&
    (await gitTag(cwd, file)) === "H" &&
    (await gitSays(cwd, ["diff", "--quiet", "HEAD", "--", file]))
  )
}

const MAX_NEW_ERRORS = 5
const UNCHECKED_LANGUAGES = new Set(["plaintext", "markdown", "log", "ignore"])
const UNCHECKED_FILES = /\.(md|markdown|txt|log|csv)$|(^|[\\/])\.\w*ignore$/i

const errorsIn = (uri: Uri) =>
  languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)

const changedLines = ({ startLine, text }: Replacement) =>
  text ? { start: startLine, end: startLine + text.split("\n").length - 1 } : { start: startLine, end: startLine - 1 }

const FIRST_CHECK_QUIET_MS = 1200

const withNewErrors = async (
  view: WorkspaceView,
  file: string,
  mode: ChatEditMode,
  changed: { start: number; end: number } | undefined,
  change: () => Promise<ChatEditOutcome>
): Promise<EditOutcome> => {
  if (mode !== "apply" || UNCHECKED_FILES.test(file)) return change()
  const uri = Uri.file(file)
  const open = workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (open && UNCHECKED_LANGUAGES.has(open.languageId)) return change()
  const known = !!open && !!changed
  const before = known ? errorsIn(uri).map((diagnostic) => diagnostic.message) : []
  const checked = settledDiagnostics(uri, known ? DIAGNOSTICS_QUIET_MS : FIRST_CHECK_QUIET_MS)
  const outcome = await change()
  if (!outcome.ok || outcome.pending) return outcome
  await checked
  const fresh = errorsIn(uri).filter((diagnostic) => {
    if (!known) {
      const line = diagnostic.range.start.line
      return !changed || (line >= changed.start && line <= changed.end)
    }
    const seen = before.indexOf(diagnostic.message)
    if (seen === -1) return true
    before.splice(seen, 1)
    return false
  })
  if (!fresh.length) return outcome
  const one = fresh.length === 1
  const named = fresh
    .slice(0, MAX_NEW_ERRORS)
    .map(
      (diagnostic) =>
        `${diagnostic.range.start.line + 1}: ${diagnostic.message.split("\n")[0]}${diagnostic.source ? ` (${diagnostic.source})` : ""}`
    )
  const more = fresh.length > named.length ? `\n… and ${fresh.length - named.length} more` : ""
  const where = known
    ? `that ${one ? "was" : "were"} not there before`
    : changed
      ? "on the lines you changed"
      : "in the new file"
  return {
    ...outcome,
    newErrors: fresh.length,
    message:
      `${outcome.message}\nThe editor now reports ${one ? "an error" : `${fresh.length} errors`} in ${view.relative(file)} ${where}:\n` +
      `${named.join("\n")}${more}\nFix ${one ? "it" : "them"} if your change caused ${one ? "it" : "them"}.`
  }
}

export const editorEdits = (
  view: WorkspaceView,
  mode: ChatEditMode,
  approve: ApproveChange,
  changes?: Pick<ReplyChanges, "touch" | "hold">
): EditSink & FileOpsSink => {
  const isProtected = (file: string) => isProtectedPath(view.relative(file)) || isProtectedPath(view.realRelative(file))
  const modeFor = (file: string): ChatEditMode => (isProtected(file) ? "review" : mode)
  const held = <T>(work: () => Promise<T>): Promise<T> => changes?.hold(work()) ?? work()
  return {
    mode,
    edit: (file, replacement) =>
      withNewErrors(view, file, modeFor(file), changedLines(replacement), () =>
        held(async () => {
          if (modeFor(file) === "apply") await changes?.touch(file)
          return (
            (await commands.executeCommand<ChatEditOutcome>(
              POINTER_COMMAND_NAME.chatFileEdit,
              { file, ...replacement },
              modeFor(file)
            )) ?? {
              ok: false,
              message: "Not changed: the editor did not answer."
            }
          )
        })
      ),
    create: (file, content) =>
      withNewErrors(view, file, modeFor(file), undefined, () =>
        held(async () => {
          if (modeFor(file) === "apply") await changes?.touch(file)
          return (
            (await commands.executeCommand<ChatEditOutcome>(
              POINTER_COMMAND_NAME.chatFileCreate,
              file,
              content,
              modeFor(file)
            )) ?? {
              ok: false,
              message: "Not created: the editor did not answer."
            }
          )
        })
      ),
    async remove(file) {
      const relative = view.relative(file)
      const lost = mode === "apply" && !isProtected(file) && !(await recoverableFromGit(file))
      if (
        (mode === "review" || isProtected(file) || lost) &&
        !(await approve(`delete ${relative}${lost ? "\n(git has no copy of it as it is now)" : ""}`, "change"))
      ) {
        return { ok: false, message: "The user chose not to delete it." }
      }
      return held(async () => {
        await changes?.touch(file)
        const edit = new WorkspaceEdit()
        edit.deleteFile(Uri.file(file), { ignoreIfNotExists: false })
        return (await workspace.applyEdit(edit))
          ? { ok: true, message: `Deleted ${relative}.` }
          : { ok: false, message: `The editor refused to delete ${relative}.` }
      })
    },
    async move(from, to) {
      const [source, target] = [view.relative(from), view.relative(to)]
      if (
        (mode === "review" || isProtected(from) || isProtected(to)) &&
        !(await approve(`move ${source} → ${target}`, "change"))
      ) {
        return { ok: false, message: "The user chose not to move it." }
      }
      return held(async () => {
        await changes?.touch(from)
        await changes?.touch(to)
        const edit = new WorkspaceEdit()
        edit.renameFile(Uri.file(from), Uri.file(to), { overwrite: false })
        return (await applyAndSave(edit))
          ? { ok: true, message: `Moved ${source} to ${target}.` }
          : { ok: false, message: `The editor refused to move ${source}.` }
      })
    }
  }
}

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

export const editorKnowledge = (
  view: WorkspaceView,
  mode: ChatEditMode,
  approve: ApproveChange,
  replyChanges?: Pick<ReplyChanges, "touch" | "hold">
): EditorSink => ({
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
    if (
      (mode === "review" || files.some(isProtectedPath)) &&
      !(await approve(`rename to ${newName}: ${changes} changes in ${files.join(", ")}`, "change"))
    ) {
      return { ok: false, message: "The user chose not to rename it." }
    }
    const rename = async () => {
      for (const [uri] of edit!.entries()) await replyChanges?.touch(uri.fsPath)
      return applyAndSave(edit!)
    }
    return (await (replyChanges?.hold(rename()) ?? rename()))
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

export const editorHint = (view: WorkspaceView): string => {
  const editor = window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== "file" || !view.visible(editor.document.uri.fsPath)) return ""
  const file = view.relative(editor.document.uri.fsPath)
  const { selection } = editor
  return selection.isEmpty
    ? `The user's active editor is ${file}, cursor on line ${selection.active.line + 1}.`
    : `The user's active editor is ${file}, with lines ${selection.start.line + 1}-${selection.end.line + 1} selected.`
}

export const TOOLS_TERMINAL = `${POINTER} tools`

const busy = new WeakSet<Terminal>()
const withoutIntegration = new WeakSet<Terminal>()

const lastEnded = new WeakMap<Terminal, number>()
const CWD_SETTLE_MS = 2000

const toolsTerminal = (cwd: string): { terminal: Terminal; fresh: boolean } => {
  const existing = window.terminals.find(
    (terminal) => terminal.name === TOOLS_TERMINAL && terminal.exitStatus === undefined && !busy.has(terminal)
  )
  return existing
    ? { terminal: existing, fresh: false }
    : {
        terminal: window.createTerminal({ name: TOOLS_TERMINAL, cwd }),
        fresh: true
      }
}

const integrationOf = (terminal: Terminal): Promise<TerminalShellIntegration | undefined> => {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration)
  if (withoutIntegration.has(terminal)) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose()
      withoutIntegration.add(terminal)
      resolve(undefined)
    }, INTEGRATION_WAIT_MS)
    const listener = window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal !== terminal) return
      clearTimeout(timer)
      listener.dispose()
      resolve(event.shellIntegration)
    })
  })
}

type Ended = { exitCode?: number } | "timeout" | "stopped"

const execute = (
  terminal: Terminal,
  run: () => ReturnType<TerminalShellIntegration["executeCommand"]>,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: (output: string) => void
) => {
  const execution = run()
  busy.add(terminal)
  let output = ""
  const reading = (async () => {
    for await (const chunk of execution.read()) {
      output = (output + chunk).slice(-MAX_CAPTURE_CHARS)
      onOutput?.(output)
    }
  })().catch((error) => logger.warn(`Chat command output: ${error}`))

  let settle: (ended: Ended) => void = () => undefined
  const ended = new Promise<Ended>((resolve) => {
    settle = resolve
  })
  const release = () => {
    finished.dispose()
    closed.dispose()
    busy.delete(terminal)
    lastEnded.set(terminal, Date.now())
  }
  const finished = window.onDidEndTerminalShellExecution((event) => {
    if (event.execution !== execution) return
    release()
    settle({ exitCode: event.exitCode })
  })
  const closed = window.onDidCloseTerminal((gone) => {
    if (gone !== terminal) return
    release()
    settle({ exitCode: gone.exitStatus?.code })
  })
  const timer = setTimeout(() => settle("timeout"), timeoutMs)
  const stop = () => {
    terminal.sendText("\x03", false)
    settle("stopped")
  }
  if (signal?.aborted) stop()
  else signal?.addEventListener("abort", stop, { once: true })
  void ended.then(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
  })
  return { ended, output: () => output, reading }
}

const runInTerminal = async (
  terminal: Terminal,
  integration: TerminalShellIntegration,
  command: string,
  cwd: string,
  fresh: boolean,
  signal?: AbortSignal,
  onOutput?: (output: string) => void
): Promise<CommandOutcome> => {
  const idle = Date.now() - (lastEnded.get(terminal) ?? 0) > CWD_SETTLE_MS
  if (!fresh && !(idle && integration.cwd?.fsPath === cwd)) {
    await execute(terminal, () => integration.executeCommand("cd", [cwd]), 5000, signal).ended
  }
  const run = execute(terminal, () => integration.executeCommand(command), COMMAND_TIMEOUT_MS, signal, onOutput)
  const ended = await run.ended
  await Promise.race([run.reading, new Promise((resolve) => setTimeout(resolve, 300))])
  const tail = tailOutput(stripAnsi(run.output()), OUTPUT_TAIL)
  if (ended === "timeout") return { ran: true, output: tail, timedOut: "running" }
  if (ended === "stopped") return { ran: true, output: tail, timedOut: "stopped" }
  return { ran: true, output: tail, exitCode: ended.exitCode }
}

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
  signal?: AbortSignal,
  onOutput?: (output: string) => void,
  timeoutMs = COMMAND_TIMEOUT_MS
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
      onOutput?.(output)
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
    timers.push(setTimeout(stop, timeoutMs))
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

const askInNotification = async (command: string) =>
  (await window.showInformationMessage(`Pointer wants to run: ${command}`, "Run", "Skip")) === "Run"

export const terminalCommands = (
  mode: (command: string) => "ask" | "allow",
  cwd: string,
  approve: (command: string) => Promise<boolean> = askInNotification,
  options: {
    place?: ChatCommandPlace
    onOutput?: (output: string) => void
    onStart?: (stop: () => void) => void
    timeoutMs?: number
    lifetime?: AbortSignal
    changes?: Pick<ReplyChanges, "touchWith" | "hold">
    visible?: (file: string) => boolean
  } = {}
): CommandSink => ({
  get mode() {
    return mode("")
  },
  async run(command, signal) {
    if (mode(command) === "ask") {
      if (!(await approve(command))) {
        logger.info(`Chat command skipped: ${command}`)
        return { ran: false, output: "" }
      }
    }
    if (signal?.aborted) return { ran: false, output: "" }
    logger.info(`Chat command: ${command}`)
    let current = true
    const onOutput = options.onOutput && ((output: string) => current && options.onOutput!(stripAnsi(output)))
    const own = new AbortController()
    const follow = () => own.abort()
    signal?.addEventListener("abort", follow, { once: true })
    options.lifetime?.addEventListener("abort", follow, { once: true })
    if (options.lifetime?.aborted) follow()
    let stoppedByUser = false
    options.onStart?.(() => {
      stoppedByUser = true
      own.abort()
    })
    const before = options.changes ? await snapshotTree(cwd) : undefined
    try {
      const outcome = await (async () => {
        if (options.place !== "terminal") return runInBackground(command, cwd, own.signal, onOutput, options.timeoutMs)
        const { terminal, fresh } = toolsTerminal(cwd)
        terminal.show(true)
        const integration = await integrationOf(terminal)
        if (integration) return runInTerminal(terminal, integration, command, cwd, fresh, own.signal, onOutput)
        logger.info("Chat command: no shell integration in the tools terminal, running in the background")
        return runInBackground(command, cwd, own.signal, onOutput, options.timeoutMs)
      })()
      return stoppedByUser && outcome.timedOut === "stopped" ? { ...outcome, stoppedByUser: true } : outcome
    } finally {
      current = false
      signal?.removeEventListener("abort", follow)
      options.lifetime?.removeEventListener("abort", follow)
      if (before && options.changes) {
        await options.changes.hold(keepCommandChanges(before, cwd, command, options.changes, options.visible))
      }
    }
  }
})

const keepCommandChanges = async (
  before: TreeSnapshot,
  cwd: string,
  command: string,
  changes: Pick<ReplyChanges, "touchWith">,
  visible: (file: string) => boolean = () => true
) => {
  const started = Date.now()
  const after = await snapshotTree(cwd)
  if (!after) return
  const changed = await changesBetween(before, after)
  const took = Date.now() - started
  if (!changed) {
    logger.warn(`Chat command changed more than ${MAX_COMMAND_CHANGES} files; they are not listed for undo: ${command}`)
    return
  }
  const shown = changed.filter((change) => visible(change.file))
  for (const change of shown) changes.touchWith(change.file, change.before)
  logger.info(
    `Chat command changed ${shown.length} file${shown.length === 1 ? "" : "s"} (read from git in ${took} ms): ${command}`
  )
}

export const normalCommand = (command: string) => command.trim().replace(/\s+/g, " ")

