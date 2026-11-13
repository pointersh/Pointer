import { execFile } from "child_process"
import fs from "fs"
import path from "path"

import {
gitNamedPaths,
globToRegExp,readOnlyGitArgs,
tidyGitPath,
withoutHiddenDiffs,
withoutHiddenLines
} from "./helpers"
import { clip, plural, ToolInputError, WorkspaceView } from "./view"
import type { EditOutcome, Tool } from "./workspace"

const MAX_FOUND_FILES = 100
const MAX_GIT_OUTPUT = 10_000
const GIT_TIMEOUT_MS = 20_000
const MAX_LOCATIONS = 50

export interface EditorLocation {
  file: string
  line: number
}

export interface EditorDiagnostic extends EditorLocation {
  severity: "error" | "warning" | "info"
  message: string
  source?: string
}

export interface EditorContextView {
  activeFile?: string
  cursorLine?: number
  selection?: { startLine: number; endLine: number; text: string }
  openFiles: string[]
}

export interface EditorSink {
  diagnostics(file?: string): Promise<EditorDiagnostic[]>
  references(file: string, line: number, character: number): Promise<EditorLocation[]>
  definition(file: string, line: number, character: number): Promise<EditorLocation[]>
  rename(file: string, line: number, character: number, newName: string): Promise<EditOutcome & { files?: string[] }>
  context(): Promise<EditorContextView>
}

const globWords = (glob: string) =>
  [...new Set(glob.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])].filter(
    (word) => !["src", "test", "tests", "index"].includes(word)
  )

export const findFiles = (view: WorkspaceView): Tool => ({
  name: "find_files",
  readOnly: true,
  description:
    "Files and folders whose path matches a glob, e.g. **/*.test.ts or src/**/index.*; a pattern without / matches the name anywhere. Folders end in /.",
  parameters: [{ name: "pattern", description: "A glob." }],
  async run({ pattern }) {
    const glob = pattern?.trim().replace(/\/+$/, "")
    if (!glob) throw new ToolInputError("find_files needs a pattern.")
    const regex = globToRegExp(glob)
    const files = (await view.allFiles()).map((file) => view.relative(file)).filter((rel) => regex.test(rel))
    const dirs = (await view.allDirs()).map((dir) => view.relative(dir))
    const matches = [...dirs.filter((rel) => regex.test(rel)).map((rel) => `${rel}/`), ...files].sort()
    const shown = matches.slice(0, MAX_FOUND_FILES)
    if (!shown.length) {
      const words = globWords(glob)
      const near = dirs
        .filter((rel) => words.some((word) => (rel.split("/").pop() ?? "").toLowerCase().includes(word)))
        .slice(0, 5)
      return {
        output: near.length ? `No files match. Folders with a similar name: ${near.map((rel) => `${rel}/`).join(", ")}` : "No files match.",
        summary: `found files \`${glob}\` · none`
      }
    }
    return {
      output: shown.join("\n") + (matches.length > shown.length ? `\n… ${matches.length - shown.length} more; narrow the pattern` : ""),
      summary: `found files \`${glob}\` · ${plural(files.length, "file")}${matches.length > files.length ? `, ${plural(matches.length - files.length, "folder")}` : ""}`
    }
  }
})

const GIT_PINNED = [
  "--no-pager",
  "-c", "color.ui=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "core.quotepath=false"
]

const runGit = (root: string, args: string[], signal?: AbortSignal) =>
  new Promise<{ output: string; exitCode: number }>((resolve) => {
    const child = execFile(
      "git",
      [...GIT_PINNED, ...args],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        signal
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
        resolve({ output, exitCode: code })
      }
    )
    child.stdin?.end()
  })

const cutToLine = (text: string, max: number) => {
  if (text.length <= max) return text
  const newline = text.lastIndexOf("\n", max)
  return text.slice(0, newline > max / 2 ? newline : max)
}

export const git = (view: WorkspaceView): Tool => {
  let prefix: Promise<string> | undefined
  const repoPrefix = () =>
    (prefix ??= runGit(view.root, ["rev-parse", "--show-prefix"]).then(({ output, exitCode }) =>
      exitCode === 0 ? output.trim() : ""
    ))
  const ignoredHere = (relative: string) => {
    if (!relative) return false
    let isDirectory: boolean | undefined
    try {
      isDirectory = fs.statSync(path.join(view.root, relative)).isDirectory()
    } catch {
      isDirectory = undefined
    }
    return isDirectory === undefined
      ? view.ignored(relative) || view.ignored(relative, true)
      : view.ignored(relative, isDirectory)
  }
  const hiddenIn = (inRepo: string, at: string) =>
    inRepo.startsWith(at) ? ignoredHere(inRepo.slice(at.length)) : at !== ""
  const hiddenHere = (relative: string) =>
    relative.startsWith(":") || /^\.\.(\/|$)/.test(path.posix.normalize(relative.replace(/\\/g, "/"))) || path.isAbsolute(relative) || ignoredHere(relative)

  const refuseBareArguments = async (args: string[], signal?: AbortSignal): Promise<string | undefined> => {
    const [subcommand, ...rest] = args
    const split = rest.indexOf("--")
    for (const arg of split === -1 ? rest : rest.slice(0, split)) {
      if (arg.startsWith("-") || /^[^:]*:/.test(arg)) continue
      const tidied = tidyGitPath(arg)
      if (path.isAbsolute(arg) || /^\.\.(\/|$)/.test(tidied)) return `${arg} is outside the workspace and cannot be read.`
      if (tidied && fs.existsSync(path.join(view.root, tidied)) && ignoredHere(tidied)) {
        return `${arg} is outside the workspace or ignored by .gitignore and cannot be read.`
      }
      if (subcommand === "show" || subcommand === "diff") {
        const { output, exitCode } = await runGit(view.root, ["cat-file", "-t", arg], signal)
        if (exitCode === 0 && output.trim() === "blob") {
          return `${arg} is a file's contents by id, which git here does not show; name the file instead, e.g. show HEAD:path/to/file.`
        }
      }
    }
    return undefined
  }

  return {
    name: "git",
    readOnly: true,
    description:
      "Run a read-only git command in the workspace: status, diff, log, show, blame, branch (listing), shortlog, ls-files, rev-parse. No approval needed; nothing is changed.",
    guidance: "Use git to see what changed (git diff, git status) or the history of a file (git log -p -- path) before you edit.",
    parameters: [{ name: "args", description: "The git command without `git`, e.g. `diff --stat` or `log -5 --oneline -- src/a.ts`." }],
    async run({ args }, context) {
      const line = args?.trim()
      if (!line) throw new ToolInputError("git needs arguments, e.g. status.")
      const parsed = readOnlyGitArgs(line)
      if (typeof parsed === "string") throw new ToolInputError(`${parsed}.`)
      const at = await repoPrefix()
      const named = gitNamedPaths(parsed).find((p) => (p.inRepo ? hiddenIn(p.path, at) : hiddenHere(p.path)))
      if (named) throw new ToolInputError(`${named.path} is outside the workspace or ignored by .gitignore and cannot be read.`)
      const refusal = await refuseBareArguments(parsed, context?.signal)
      if (refusal) throw new ToolInputError(refusal)
      const { output: raw, exitCode } = await runGit(view.root, parsed, context?.signal)
      const listed = parsed[0] === "ls-files" ? withoutHiddenLines(raw, hiddenHere) : { text: raw, dropped: 0 }
      const diffs = withoutHiddenDiffs(listed.text, (file) => hiddenIn(file, at))
      const text = diffs.text
      const dropped = diffs.dropped + listed.dropped
      const shown =
        text.length > MAX_GIT_OUTPUT
          ? `${cutToLine(text, MAX_GIT_OUTPUT)}\n… ${text.length - MAX_GIT_OUTPUT} more characters; narrow it with a path, -n or --stat`
          : text
      const command = line.replace(/^\s*git\s+/, "")
      return {
        output: `$ git ${command}\n(exit code ${exitCode})\n${shown.trim() || "(no output)"}`,
        summary:
          `git \`${command}\`` +
          (exitCode ? ` · exit ${exitCode}` : "") +
          (dropped ? ` · ${plural(dropped, "file")} left out` : ""),
        failed: exitCode !== 0
      }
    }
  }
}

export const diagnostics = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "diagnostics",
  description:
    "The errors and warnings the editor's language servers report for a file. Without a path: for every file the editor has checked, which is usually the open ones.",
  guidance: "After editing, call diagnostics on the files you changed to catch errors before you finish.",
  parameters: [{ name: "path", description: "A file; everything the editor has checked when left out.", optional: true }],
  async run({ path: file }) {
    const absolute = file ? view.resolve(file, "file") : undefined
    const found = (await editor.diagnostics(absolute)).filter(
      (d) => d.severity !== "info" && view.visible(d.file)
    )
    const errors = found.filter((d) => d.severity === "error").length
    const where = absolute ? `\`${view.relative(absolute)}\`` : "the workspace"
    return {
      output: found.length
        ? found
            .slice(0, MAX_LOCATIONS)
            .map((d) => `${view.relative(d.file)}:${d.line}: ${d.severity}: ${clip(d.message)}${d.source ? ` (${d.source})` : ""}`)
            .join("\n") + (found.length > MAX_LOCATIONS ? `\n… ${found.length - MAX_LOCATIONS} more` : "")
        : `No errors or warnings in ${absolute ? view.relative(absolute) : "the files the editor has checked"}.`,
      summary: `checked ${where} · ${found.length ? `${plural(errors, "error")}, ${plural(found.length - errors, "warning")}` : "clean"}`
    }
  }
})
