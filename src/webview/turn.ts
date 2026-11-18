import { ToolStepView } from "../common/types"

import { PointedChunk } from "./ui/pointingAt"
import { ToolDetailLine, ToolDiff, ToolIcon, ToolRow, ToolRowStatus } from "./ui/toolChips"

const WRITES = new Set(["edit_file", "create_file"])

const VERBS: Record<string, [string, ToolIcon]> = {
  search_codebase: ["Pointed", "point"],
  read_file: ["Read", "read"],
  list_dir: ["Listed", "read"],
  find_files: ["Found files", "search"],
  grep: ["Searched", "search"],
  find_symbol: ["Looked up", "search"],
  repo_map: ["Mapped the repo", "point"],
  index_status: ["Checked the index", "point"],
  go_to_definition: ["Went to definition", "search"],
  find_references: ["Found references", "search"],
  diagnostics: ["Checked problems", "read"],
  editor_context: ["Read the editor", "read"],
  edit_file: ["Edited", "write"],
  create_file: ["Created", "write"],
  rename_symbol: ["Renamed", "write"],
  move_file: ["Moved", "write"],
  delete_file: ["Deleted", "write"],
  run_command: ["Ran", "run"],
  git: ["Git", "run"],
  create_sub_agent: ["Sub-agent surveyed", "point"]
}

const RUNNING: Record<string, string> = {
  search_codebase: "Pointing",
  read_file: "Reading",
  grep: "Searching",
  find_files: "Finding files",
  find_symbol: "Looking up",
  edit_file: "Editing",
  create_file: "Creating",
  run_command: "Running",
  create_sub_agent: "Sub-agent surveying"
}

// What the user declined, in their words: "Skipped edit", not "Skipped · edited".
const SKIPPED: Record<string, string> = {
  edit_file: "Skipped edit",
  create_file: "Skipped new file",
  run_command: "Skipped command",
  delete_file: "Skipped delete",
  move_file: "Skipped move",
  rename_symbol: "Skipped rename"
}

const status = (step: ToolStepView): ToolRowStatus =>
  step.status === "running" ? "running" : step.status === "waiting" ? "waiting" : step.status === "done" ? "done" : "error"

const short = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const linesOf = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : [])

const chipOf = (step: ToolStepView) => {
  const a = step.args ?? {}
  switch (step.name) {
    case "read_file":
      return a.start_line ? `${a.path} · ${a.start_line}–${a.end_line ?? "end"}` : a.path
    case "search_codebase":
      return short(a.query ?? "", 48)
    case "grep":
      return a.pattern ?? a.query
    case "find_files":
      return a.pattern ?? a.glob ?? a.query
    case "find_symbol":
    case "rename_symbol":
      return a.name ?? a.symbol
    case "run_command":
      return a.command
    case "git":
      return a.args ?? a.command
    case "move_file":
      return a.from && a.to ? `${a.from} → ${a.to}` : a.path
    case "create_sub_agent":
      return short(String(a.input ?? a.task ?? a.name ?? ""), 60)
    default:
      return a.path ?? Object.values(a)[0]
  }
}

interface EditPair {
  find: string
  replace: string
}

const editPairs = (step: ToolStepView): EditPair[] => {
  const a = step.args ?? {}
  if (step.name === "create_file") return [{ find: "", replace: a.content ?? "" }]
  if (a.edits) {
    try {
      const parsed = JSON.parse(a.edits) as { find?: string; replace?: string }[]
      return parsed.map((e) => ({ find: e.find ?? "", replace: e.replace ?? "" }))
    } catch {
      return []
    }
  }
  return [{ find: a.find ?? "", replace: a.replace ?? "" }]
}

const changed = ({ find, replace }: EditPair) => {
  const before = linesOf(find)
  const after = linesOf(replace)
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  return { removed: before.slice(head, before.length - tail), added: after.slice(head, after.length - tail) }
}

const diffLines = (pairs: EditPair[]): ToolDetailLine[] =>
  pairs.flatMap((pair) => {
    const { removed, added } = changed(pair)
    return [...removed.map((text) => ({ text, tone: "del" as const })), ...added.map((text) => ({ text, tone: "add" as const }))]
  })

export const toRow = (step: ToolStepView): ToolRow => {
  const [verb, icon] = VERBS[step.name] ?? [step.name.replace(/_/g, " "), "run" as ToolIcon]
  const running = step.status === "running" || step.status === "waiting"
  const label = running ? (RUNNING[step.name] ?? verb) : step.status === "skipped" ? (SKIPPED[step.name] ?? "Skipped") : verb
  const chip = chipOf(step)
  if (WRITES.has(step.name) && step.status !== "skipped") {
    return { id: step.id, icon, label, chip, mono: true, status: status(step), detail: diffLines(editPairs(step)).slice(0, 40), detailMono: true }
  }
  const output = (step.output ?? "").trim()
  const detail = output && step.name !== "search_codebase" ? linesOf(output).slice(0, 40).map((text) => ({ text })) : undefined
  return { id: step.id, icon, label, chip, mono: true, status: status(step), detail, detailMono: true }
}

export const diffsOf = (steps: ToolStepView[], open: (path: string) => void): ToolDiff[] => {
  const byFile = new Map<string, ToolDiff>()
  for (const step of steps) {
    if (!WRITES.has(step.name) || step.status !== "done" || !step.args?.path) continue
    const pairs = editPairs(step)
    const path = step.args.path
    const current = byFile.get(path) ?? { file: path.split("/").pop() ?? path, add: 0, del: 0, lines: [], onOpen: () => open(path) }
    current.add += pairs.reduce((n, p) => n + changed(p).added.length, 0)
    current.del += pairs.reduce((n, p) => n + changed(p).removed.length, 0)
    current.lines = [...(current.lines ?? []), ...diffLines(pairs)].slice(0, 12)
    byFile.set(path, current)
  }
  return [...byFile.values()]
}

const CHUNK_LINE = /^\s*-?\s*(.+?):(\d+)-(\d+)\s+·\s+([\d.]+)\s+·\s+(.+)$/

// Every search_codebase call in the turn, one row per file: its best chunk, plus how many more it had.
export const pointedFiles = (steps: ToolStepView[]): { chunks: PointedChunk[]; dropped?: string } | undefined => {
  const searches = steps.filter((s) => s.name === "search_codebase" && s.output)
  const byFile = new Map<string, PointedChunk>()
  for (const step of searches) {
    for (const line of step.output!.split("\n")) {
      const m = CHUNK_LINE.exec(line)
      if (!m) continue
      const chunk = { path: m[1], start: Number(m[2]), end: Number(m[3]), score: Number(m[4]), reason: m[5], more: 0 }
      const seen = byFile.get(chunk.path)
      if (!seen) byFile.set(chunk.path, chunk)
      else byFile.set(chunk.path, seen.score >= chunk.score ? { ...seen, more: seen.more + 1 } : { ...chunk, more: seen.more + 1 })
    }
  }
  if (!byFile.size) return undefined
  const dropped = searches.map((s) => /dropped \d+[^\n]*/.exec(s.output!)?.[0]).filter(Boolean).pop()
  return { chunks: [...byFile.values()].sort((a, b) => b.score - a.score), dropped }
}

export const runningLabel = (steps: ToolStepView[]) => {
  const step = [...steps].reverse().find((s) => s.status === "running")
  return step ? (RUNNING[step.name] ?? "Working") : undefined
}

export const changeSummary = (step: ToolStepView) => {
  const pairs = editPairs(step)
  const add = pairs.reduce((n, p) => n + changed(p).added.length, 0)
  const del = pairs.reduce((n, p) => n + changed(p).removed.length, 0)
  return `${step.args?.path ?? step.name} · +${add} −${del}`
}
