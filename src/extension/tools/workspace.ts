import * as vm from "vm"

import { EditRequest, planEdits, Replacement } from "./edit"
import {
deleteFile,
diagnostics,
editorContext,
EditorSink,
FileOpsSink,
findFiles,
findReferences,
git,
goToDefinition,
insideGitRepository,
moveFile,
renameSymbol
} from "./more"
import { outlineOf, outlineText } from "./outline"
import { parseLenientJson, ToolSpec } from "./protocol"
import { clip, linesOf, plural, ToolInputError, WorkspaceView } from "./view"

interface ToolResult {
  output: string
  summary: string
  failed?: boolean
  final?: boolean
  preface?: string
  digest?: string
}

interface ToolContext {
  signal?: AbortSignal
  roomChars?: number
}

export interface Tool extends ToolSpec {
  run(args: Record<string, string>, context?: ToolContext): Promise<ToolResult>
}

const MAX_READ_LINES = 150
const MOST_READ_LINES = 500
const CHARS_PER_LINE = 45
const EDIT_CONTEXT_LINES = 2
const MAX_EDIT_SHOWN_LINES = 30
const MAX_UNREAD_SHOWN_LINES = 80
const MAX_GREP_MATCHES = 40
const MAX_GREP_PER_FILE = 10
const MAX_GREP_OTHER_FILES = 15
const GREP_CONTEXT_MATCHES = 6
const GREP_CONTEXT_LINES = 2
const MAX_LIST_ENTRIES = 150
const MAX_SYMBOL_MATCHES = 15
const SEARCH_BUDGET_MS = 8000

// The model's regex runs inside vm with a timeout: a catastrophic pattern like (a+)+$ is interrupted
// instead of freezing the extension host. Costs about 0.1 ms per file.
const regexSandbox = vm.createContext({})
const matchingLines = (regex: RegExp, lines: string[], timeoutMs: number): number[] => {
  Object.assign(regexSandbox, { regex, lines, hits: [] })
  try {
    vm.runInContext("lines.forEach((line, i) => { if (regex.test(line)) hits.push(i) })", regexSandbox, {
      timeout: Math.min(1000, Math.max(50, timeoutMs))
    })
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new ToolInputError("grep stopped: that regular expression is too slow (nested repetition such as (a+)+). Use a simpler pattern.")
    }
    throw error
  }
  const hits = regexSandbox.hits as number[]
  Object.assign(regexSandbox, { regex: undefined, lines: undefined, hits: undefined })
  return hits
}
const MAX_MATCHED_LINE_CHARS = 2000

export interface EditSink {
  read?(file: string): Promise<string | undefined>
  edit(file: string, replacement: Replacement, signal?: AbortSignal): Promise<EditOutcome>
  create(file: string, content: string, signal?: AbortSignal): Promise<EditOutcome>
}

export interface EditOutcome {
  ok: boolean
  message: string
  pending?: boolean
  newErrors?: number
}

const errorsNote = (outcome: EditOutcome) =>
  outcome.newErrors ? ` · ${plural(outcome.newErrors, "new error")}` : ""

const cutToLast = (list: string, max: number): { text: string; cut: boolean } => {
  if (list.length <= max) return { text: list, cut: false }
  const end = list.lastIndexOf(", ", max)
  return { text: end > 0 ? list.slice(0, end) : "", cut: true }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const literalPattern = (pattern: string) =>
  new RegExp(escapeRegex(pattern), pattern === pattern.toLowerCase() ? "i" : "")

const searchPattern = (pattern: string) => {
  try {
    return new RegExp(pattern, pattern === pattern.toLowerCase() ? "i" : "")
  } catch {
    return literalPattern(pattern)
  }
}

const definitionPattern = (name: string) => {
  const n = escapeRegex(name)
  return new RegExp(
    [
      `\\b(?:function\\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|module|namespace|record|object)\\s+${n}\\b`,
      `\\b(?:const|let|var|val)\\s+${n}\\s*[=:]`,
      `^\\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)+\\*?${n}\\s*[(<=:]`,
      `^\\s*${n}\\s*\\([^)]*\\)\\s*(?::[^=]*)?\\{\\s*$`,
      `\\btype\\s+${n}\\s+(?:struct|interface)\\b`
    ].join("|")
  )
}

const listDir = (view: WorkspaceView): Tool => ({
  name: "list_dir",
  readOnly: true,
  description: "The files and folders in a directory.",
  parameters: [{ name: "path", description: "The directory; the workspace root by default.", optional: true }],
  async run({ path: dir }) {
    const absolute = view.resolve(dir, "dir")
    const entries = view.entries(absolute)
    const shown = entries.slice(0, MAX_LIST_ENTRIES)
    const more = entries.length - shown.length
    const where = view.relative(absolute)
    return {
      output:
        shown.map((e) => (e.dir ? `${e.name}/` : e.name)).join("\n") +
        (more > 0 ? `\n… ${more} more` : "") || "(empty)",
      summary: `listed ${where === "." ? "the workspace root" : `\`${where}\``} · ${plural(entries.length, "entry", "entries")}`
    }
  }
})

const readFile = (view: WorkspaceView, seen: Map<string, string>): Tool => ({
  name: "read_file",
  readOnly: true,
  description: "A file's lines, numbered. A long file comes a part at a time, with what is defined further down; ask for a range to read on.",
  parameters: [
    { name: "path", description: "The file." },
    { name: "start_line", description: "First line to read, from 1.", optional: true, type: "integer" },
    { name: "end_line", description: "Last line to read.", optional: true, type: "integer" }
  ],
  async run({ path: file, start_line, end_line }, context) {
    if (!file) throw new ToolInputError("read_file needs a path.")
    const absolute = view.resolve(file, "file")
    const rel = view.relative(absolute)
    const text = await view.text(absolute)
    if (text === undefined) throw new ToolInputError(`${rel} is binary or too large to read.`)
    const lines = linesOf(text)
    if (!lines.length) return { output: `${rel} is empty.`, summary: `read \`${rel}\` · empty` }
    const start = Math.max(1, Number.parseInt(start_line ?? "", 10) || 1)
    if (start > lines.length) {
      throw new ToolInputError(`${rel} has only ${plural(lines.length, "line")}.`)
    }
    const asked = Math.max(start, Number.parseInt(end_line ?? "", 10) || lines.length)
    const room = context?.roomChars
    const most = room ? Math.min(MOST_READ_LINES, Math.max(MAX_READ_LINES, Math.floor(room / CHARS_PER_LINE))) : MAX_READ_LINES
    const last = Math.min(lines.length, asked, start + most - 1)
    const reserve = room ? Math.min(1200, Math.floor(room / 4)) : 1200
    const rows: string[] = []
    let used = 0
    for (let i = start; i <= last; i++) {
      const row = `${i}: ${clip(lines[i - 1])}`
      if (room && rows.length >= 40 && used + row.length + 1 > room - reserve) break
      rows.push(row)
      used += row.length + 1
    }
    const end = start + rows.length - 1
    const stopped = end < Math.min(asked, lines.length)
    const below = stopped ? outlineOf(lines, end, lines.length, 50) : undefined
    const named = below ? cutToLast(outlineText(below.found), reserve - 200) : undefined
    const cut = stopped
      ? `\n… stopped at line ${end} of ${lines.length}; read on with start_line ${end + 1}` +
        (named?.text ? `\nDefined further down (line): ${named.text}${below?.more || named.cut ? ", …" : ""}` : "")
      : ""
    const header = `${rel} (lines ${start}–${end} of ${lines.length})`
    const shown = outlineOf(lines, start - 1, end, 15)
    seen.set(absolute, text)
    return {
      output: `${header}\n${rows.join("\n")}${cut}`,
      summary: `read \`${rel}:${start}–${end}\``,
      digest: shown.found.length ? `${header}; defined there (line): ${outlineText(shown.found)}${shown.more ? ", …" : ""}` : header
    }
  }
})

const grep = (view: WorkspaceView): Tool => ({
  name: "grep",
  readOnly: true,
  description:
    "Lines matching a regular expression, across the workspace or under one directory, grouped by file (`12:` is a match, `12-` a line beside one). An all-lowercase pattern ignores case.",
  parameters: [
    { name: "pattern", description: "A JavaScript regular expression." },
    { name: "path", description: "A directory to search under, or one file; the whole workspace by default.", optional: true }
  ],
  async run({ pattern, path: dir }, context) {
    if (!pattern) throw new ToolInputError("grep needs a pattern.")
    const scope = dir ? view.relative(view.resolve(dir, "any")) : "."
    const started = Date.now()
    const search = async (regex: RegExp) => {
      const shownFiles: { file: string; lines: string[]; hits: number[]; count: number }[] = []
      const others: { file: string; count: number }[] = []
      let shown = 0
      let total = 0
      let unsearched = 0
      const all = (await view.files()).filter((file) => {
        const rel = view.relative(file)
        return scope === "." || rel === scope || rel.startsWith(`${scope}/`)
      })
      let index = 0
      for await (const [file, text] of view.texts(all)) {
        if (context?.signal?.aborted || Date.now() - started > SEARCH_BUDGET_MS) {
          unsearched = all.length - index
          break
        }
        index++
        const rel = view.relative(file)
        if (!text) continue
        const lines = linesOf(text)
        const hits: number[] = []
        let count = 0
        const probes = lines.map((line) => (line.length > MAX_MATCHED_LINE_CHARS ? line.slice(0, MAX_MATCHED_LINE_CHARS) : line))
        for (const i of matchingLines(regex, probes, SEARCH_BUDGET_MS - (Date.now() - started))) {
          count++
          if (hits.length < MAX_GREP_PER_FILE && shown + hits.length < MAX_GREP_MATCHES) hits.push(i)
        }
        if (!count) continue
        total += count
        if (!hits.length) {
          others.push({ file: rel, count })
          continue
        }
        shown += hits.length
        shownFiles.push({ file: rel, lines, hits, count })
      }
      const around = total <= GREP_CONTEXT_MATCHES ? GREP_CONTEXT_LINES : 0
      const blocks = shownFiles.map(({ file, lines, hits, count }) => {
        const rows: string[] = []
        let printed = -1
        for (const hit of hits) {
          const from = Math.max(printed + 1, hit - around)
          if (around && printed !== -1 && from > printed + 1) rows.push("--")
          for (let i = from; i <= Math.min(lines.length - 1, hit + around); i++) {
            if (i > hit && hits.includes(i)) break
            rows.push(`${i + 1}${i === hit ? ":" : "-"} ${clip(around ? lines[i].trimEnd() : lines[i].trim())}`)
            printed = i
          }
        }
        return [file, ...rows, ...(count > hits.length ? [`… ${count - hits.length} more in this file`] : [])].join("\n")
      })
      return { blocks, others, total, files: blocks.length + others.length, unsearched }
    }

    const attempts: { regex: RegExp; note?: string }[] = [
      { regex: searchPattern(pattern) },
      ...(/[.*+?^${}()|[\]\\]/.test(pattern)
        ? [
            {
              regex: literalPattern(pattern),
              note: "(Nothing matched as a regular expression; these match the text as written.)"
            }
          ]
        : []),
      ...(pattern.includes("\\\\")
        ? [
            {
              regex: searchPattern(pattern.replace(/\\\\/g, "\\")),
              note: "(Nothing matched as written; these match with each doubled backslash read as one.)"
            }
          ]
        : [])
    ]
    let found = await search(attempts[0].regex)
    let note: string | undefined
    for (const attempt of attempts.slice(1)) {
      if (found.total) break
      const again = await search(attempt.regex)
      if (again.total) [found, note] = [again, attempt.note]
    }

    const { blocks, others, total, files, unsearched } = found
    const elsewhere = [...others].sort((a, b) => b.count - a.count)
    const named = elsewhere.slice(0, MAX_GREP_OTHER_FILES).map(({ file, count }) => `${file} (${count})`)
    const notes = [
      ...(elsewhere.length
        ? [
            `… also in ${named.join(", ")}` +
              (elsewhere.length > named.length ? ` and ${plural(elsewhere.length - named.length, "more file")}` : "") +
              "; narrow the pattern or the path"
          ]
        : []),
      ...(unsearched > 0 ? [`… stopped early: ${plural(unsearched, "file")} not searched; narrow the path`] : [])
    ]
    const where = [...blocks.map((block) => block.split("\n", 1)[0]), ...elsewhere.map(({ file }) => file)]
    return {
      output: blocks.length ? [...(note ? [note] : []), ...blocks, ...notes].join("\n") : ["No matches.", ...notes].join("\n"),
      summary:
        `searched for \`${pattern}\`${scope !== "." ? ` in \`${scope}\`` : ""} · ` +
        (total ? `${plural(total, "match", "matches")} in ${plural(files, "file")}` : "no matches"),
      digest: total
        ? `grep \`${pattern}\`: ${plural(total, "match", "matches")} in ${where.slice(0, 12).join(", ")}${where.length > 12 ? ", …" : ""}`
        : `grep \`${pattern}\`: no matches`
    }
  }
})

const findSymbol = (view: WorkspaceView): Tool => ({
  name: "find_symbol",
  readOnly: true,
  description: "Where a function, class, method, type or variable is defined.",
  parameters: [{ name: "name", description: "The symbol's name, exactly as written in code." }],
  async run({ name }, context) {
    const wanted = name?.trim()
    if (!wanted) throw new ToolInputError("find_symbol needs a name.")
    const regex = definitionPattern(wanted)
    const found: string[] = []
    const started = Date.now()
    for await (const [file, text] of view.texts(await view.files())) {
      if (found.length >= MAX_SYMBOL_MATCHES) break
      if (context?.signal?.aborted || Date.now() - started > SEARCH_BUDGET_MS) break
      if (!text?.includes(wanted)) continue
      linesOf(text).forEach((line, i) => {
        if (found.length < MAX_SYMBOL_MATCHES && line.length <= MAX_MATCHED_LINE_CHARS && regex.test(line)) {
          found.push(`${view.relative(file)}:${i + 1}: ${clip(line.trim())}`)
        }
      })
    }
    return {
      output: found.length
        ? found.join("\n")
        : `No definition of ${wanted} found. Try grep for where it is used.`,
      summary: `looked up \`${wanted}\` · ${found.length ? plural(found.length, "definition") : "not found"}`
    }
  }
})

const MAX_NEW_FILE_CHARS = 100_000

const createFile = (view: WorkspaceView, sink: EditSink): Tool => ({
  name: "create_file",
  acts: true,
  description:
    "Propose a new file with the given content. The user reviews it before it is saved." +
    " The file must not exist yet; use edit_file to change an existing one.",
  parameters: [
    { name: "path", description: "Where the new file goes, relative to the workspace root." },
    { name: "content", description: "The whole file." }
  ],
  async run({ path: file, content }, context) {
    if (content === undefined) throw new ToolInputError("create_file needs content.")
    if (content.length > MAX_NEW_FILE_CHARS) throw new ToolInputError("That file is too large to create in one go.")
    const absolute = view.resolveNew(file)
    const rel = view.relative(absolute)
    const outcome = await sink.create(absolute, content, context?.signal)
    if (!outcome.ok) {
      return { output: outcome.message, summary: `\`${rel}\` not created · ${outcome.message}`, failed: true }
    }
    view.forgetFiles()
    return {
      output: outcome.message,
      summary: `${outcome.pending ? "proposed a new file" : "created"} \`${rel}\` · ${plural(linesOf(content).length, "line")}${errorsNote(outcome)}`,
      final: outcome.pending
    }
  }
})

const lineNumber = (value: string | undefined) => {
  const number = Number.parseInt(value ?? "", 10)
  return Number.isFinite(number) ? number : undefined
}

const isTrue = (value: string | undefined) => /^(true|yes|1)$/i.test(value?.trim() ?? "")

const editList = (raw: string): EditRequest[] | string => {
  const parsed = parseLenientJson(raw)
  const list = "value" in parsed ? parsed.value : undefined
  if (!Array.isArray(list) || !list.length) return "edits must be a list like [{\"find\": \"…\", \"replace\": \"…\"}]"
  const edits: EditRequest[] = []
  for (const [index, entry] of list.entries()) {
    const { find, replace, replace_all } = (entry ?? {}) as Record<string, unknown>
    if (typeof find !== "string" || typeof replace !== "string") {
      return `edit ${index + 1} of ${list.length} needs find and replace, both text`
    }
    edits.push({ find, replace, all: replace_all === true || isTrue(String(replace_all ?? "")) })
  }
  return edits
}

const numbered = (lines: string[], from: number, to: number) =>
  lines
    .slice(from - 1, to)
    .map((line, i) => `${from + i}: ${clip(line)}`)
    .join("\n")

const afterEdit = (text: string, plan: Replacement): { text: string; shown: string } => {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const added = plan.text === "" ? [] : plan.text.split("\n")
  lines.splice(plan.startLine, plan.endLine - plan.startLine + 1, ...added)
  const from = Math.max(1, plan.startLine + 1 - EDIT_CONTEXT_LINES)
  const count = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
  const to = Math.max(from, Math.min(count, plan.startLine + added.length + EDIT_CONTEXT_LINES))
  const shown =
    to - from + 1 <= MAX_EDIT_SHOWN_LINES
      ? `Lines ${from}–${to} are now:\n${numbered(lines, from, to)}`
      : `Lines ${from}–${to} changed; they begin:\n${numbered(lines, from, from + MAX_EDIT_SHOWN_LINES - 1)}\n…`
  return { text: lines.join("\n"), shown }
}

const editFile = (view: WorkspaceView, sink: EditSink, seen: Map<string, string>): Tool => ({
  name: "edit_file",
  acts: true,
  description:
    "Propose changing a file by replacing an exact piece of it. The user reviews the change as a diff in the editor and nothing is saved until they accept it. One edit at a time. Copy find from read_file output, without the line numbers, with enough lines that it matches once. " +
    "Other ways to say what changes: replace_all true changes every place find is; start_line and end_line (from read_file) with replace rewrite those lines, with no find; " +
    "edits is a list of {find, replace} for several changes to one file in one call.",
  guidance:
    "When the user asks you to change code, read the lines first, then call edit_file (or create_file for a new file). The user reviews each change before it is applied, so propose one and say briefly what it does.",
  parameters: [
    { name: "path", description: "The file to change." },
    { name: "find", description: "Text already in the file, copied exactly.", optional: true },
    { name: "replace", description: "What it becomes.", optional: true },
    { name: "replace_all", description: "true to change every place find is, not just one.", optional: true, type: "boolean" },
    { name: "start_line", description: "With end_line, in place of find: the first line to rewrite.", optional: true, type: "integer" },
    { name: "end_line", description: "The last line to rewrite.", optional: true, type: "integer" },
    {
      name: "edits",
      description: "In place of find and replace: several changes to this file, made in order.",
      optional: true,
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: { find: { type: "string" }, replace: { type: "string" }, replace_all: { type: "boolean" } },
          required: ["find", "replace"]
        }
      }
    }
  ],
  async run({ path: file, find, replace, replace_all, start_line, end_line, edits }, context) {
    if (!file) throw new ToolInputError("edit_file needs a path.")
    const start = lineNumber(start_line)
    const byLines = start !== undefined && find === undefined
    let requests: EditRequest[]
    if (edits !== undefined && find === undefined && !byLines) {
      const list = editList(edits)
      if (typeof list === "string") throw new ToolInputError(`edit_file: ${list}.`)
      requests = list
    } else if (byLines) {
      if (replace === undefined) throw new ToolInputError("edit_file needs replace: what lines start_line to end_line become.")
      requests = [{ replace, startLine: start, endLine: lineNumber(end_line) ?? start }]
    } else {
      if (find === undefined || replace === undefined) throw new ToolInputError("edit_file needs find and replace.")
      requests = [{ find, replace, all: isTrue(replace_all) }]
    }
    const absolute = view.resolve(file, "file")
    const rel = view.relative(absolute)
    const text = await view.text(absolute)
    if (text === undefined) throw new ToolInputError(`${rel} is binary or too large to edit.`)
    if (byLines && seen.get(absolute) !== text) {
      seen.set(absolute, text)
      const lines = linesOf(text)
      const end = Math.min(lines.length, requests[0].endLine ?? start)
      const from = Math.max(1, Math.min(start, lines.length) - EDIT_CONTEXT_LINES)
      const to = Math.min(lines.length, Math.max(end, from) + EDIT_CONTEXT_LINES)
      throw new ToolInputError(
        `${rel} has not been read since it last changed, so those line numbers may be off. Nothing was changed. Lines ${from}–${to} are now:\n` +
          `${numbered(lines, from, to)}\nCall edit_file again with the right start_line and end_line.`
      )
    }
    const plan = planEdits(text, requests)
    if (typeof plan === "string") {
      if (/find is not in the file/.test(plan) && !/nearest match/.test(plan) && !seen.has(absolute)) {
        const lines = linesOf(text)
        const to = Math.min(lines.length, MAX_UNREAD_SHOWN_LINES)
        seen.set(absolute, text)
        throw new ToolInputError(
          `${rel}: find is not in the file. You have not read ${rel} yet, so here ${to < lines.length ? `are its first ${to} lines (of ${lines.length}; read_file shows the rest)` : "it is"}:\n` +
            `${numbered(lines, 1, to)}\n` +
            "Call edit_file again with find copied from these lines, without the line numbers; or give start_line and end_line with replace to rewrite those lines."
        )
      }
      throw new ToolInputError(`${rel}: ${plan}${/[.\n]$/.test(plan) ? "" : "."}`)
    }
    const lines =
      plan.startLine === plan.endLine ? `${plan.startLine + 1}` : `${plan.startLine + 1}–${plan.endLine + 1}`
    const outcome = await sink.edit(absolute, plan, context?.signal)
    if (!outcome.ok) {
      return { output: outcome.message, summary: `\`${rel}\` not changed · ${outcome.message}`, failed: true }
    }
    const places = plan.count > 1 ? ` · ${plan.count} places` : ""
    if (outcome.pending) {
      return { output: outcome.message, summary: `proposed an edit to \`${rel}:${lines}\`${places}`, final: true }
    }
    const after = afterEdit(text, plan)
    seen.set(absolute, after.text)
    return {
      output: `${outcome.message}${plan.count > 1 ? ` ${plan.count} places changed.` : ""}\n${after.shown}`,
      summary: `edited \`${rel}:${lines}\`${places}${errorsNote(outcome)}`
    }
  }
})

export interface CommandSink {
  run(command: string, signal?: AbortSignal): Promise<CommandOutcome>
}

export interface CommandOutcome {
  ran: boolean
  output: string
  exitCode?: number
  timedOut?: "running" | "stopped"
}

const MAX_COMMAND_CHARS = 1000

const runCommand = (sink: CommandSink): Tool => ({
  name: "run_command",
  acts: true,
  description:
    "Run a shell command in the workspace root and get its exit code and the end of its output: tests, builds, type checks. The user is asked before it runs and may skip it.",
  guidance:
    "Use run_command to check your work (tests, type checks, builds). Never run commands that delete files, rewrite history or install software unless the user asked for exactly that. Nothing can answer a prompt, and you get the output after two minutes at most: no interactive commands, servers or watch modes.",
  parameters: [{ name: "command", description: "One command line for the user's shell." }],
  async run({ command }, context) {
    const line = command?.trim()
    if (!line) throw new ToolInputError("run_command needs a command.")
    if (line.length > MAX_COMMAND_CHARS) throw new ToolInputError("That command is too long; write a shorter one.")
    const outcome = await sink.run(line, context?.signal)
    if (!outcome.ran) {
      return {
        output: "Stopped before the command ran.",
        summary: `\`${line}\` skipped`
      }
    }
    const status =
      outcome.timedOut === "running"
        ? "still running when the wait ran out; this is its output so far"
        : outcome.timedOut === "stopped"
          ? "stopped: it ran longer than the wait allows; this is its output so far"
          : outcome.exitCode === undefined
            ? "finished; the shell did not report an exit code"
            : `exit code ${outcome.exitCode}`
    const outcomeWord = outcome.timedOut
      ? outcome.timedOut === "running" ? "still running" : "timed out"
      : outcome.exitCode === undefined ? "done" : `exit ${outcome.exitCode}`
    const printed = outcome.output.trim()
    return {
      failed: outcome.timedOut === "stopped" || (!outcome.timedOut && !!outcome.exitCode),
      output: `$ ${line}\n(${status})\n${printed || "(no output)"}`,
      summary: `ran \`${line}\` · ${outcomeWord}`,
      digest: `$ ${line}\n(${status})${printed ? `\n…\n${printed.split("\n").slice(-4).join("\n").slice(-400)}` : ""}`
    }
  }
})

export interface ToolExtras {
  edits?: EditSink & Partial<FileOpsSink>
  commands?: CommandSink
  editor?: EditorSink
}

export const workspaceTools = (view: WorkspaceView, { edits, commands, editor }: ToolExtras = {}): Tool[] => {
  const seen = new Map<string, string>()
  const tools = [
    ...(editor ? [editorContext(view, editor)] : []),
    listDir(view),
    findFiles(view),
    readFile(view, seen),
    grep(view),
    findSymbol(view),
    ...(editor ? [goToDefinition(view, editor), findReferences(view, editor), diagnostics(view, editor)] : []),
    ...(insideGitRepository(view.root) ? [git(view)] : [])
  ]
  if (edits) tools.push(editFile(view, edits, seen), createFile(view, edits))
  if (edits && editor) tools.push(renameSymbol(view, editor))
  if (edits?.remove && edits.move) {
    const ops = { remove: edits.remove.bind(edits), move: edits.move.bind(edits) }
    tools.push(moveFile(view, ops), deleteFile(view, ops))
  }
  if (commands) tools.push(runCommand(commands))
  return tools
}
