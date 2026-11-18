
type DiffKind = "equal" | "remove" | "add"

interface DiffOp {
  kind: DiffKind
  line: string
}

const MAX_CELLS = 4_000_000

const op = (kind: DiffKind) => (line: string): DiffOp => ({ kind, line })
const equal = op("equal")
const remove = op("remove")
const add = op("add")

const diffLines = (a: string[], b: string[], early = false): DiffOp[] => {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (!early && endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return [
    ...a.slice(0, start).map(equal),
    ...lcsDiff(a.slice(start, endA), b.slice(start, endB), early),
    ...a.slice(endA).map(equal)
  ]
}

const lcsDiff = (a: string[], b: string[], early: boolean): DiffOp[] => {
  if (!a.length) return b.map(add)
  if (!b.length) return a.map(remove)
  if (a.length * b.length > MAX_CELLS) return [...a.map(remove), ...b.map(add)]

  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push(equal(a[i++]))
      j++
    } else if (
      early
        ? table[(i + 1) * width + j] > table[i * width + j + 1]
        : table[(i + 1) * width + j] >= table[i * width + j + 1]
    ) {
      ops.push(remove(a[i++]))
    } else {
      ops.push(add(b[j++]))
    }
  }
  while (i < a.length) ops.push(remove(a[i++]))
  while (j < b.length) ops.push(add(b[j++]))
  return ops
}

export interface Span {
  line: number
  start: number
  end: number
}

export interface DiffLayout {
  text: string
  removed: number[]
  added: number[]
  removedWords: Span[]
  addedWords: Span[]
}

const TOKEN = /\w+|\s+|[^\w\s]/g

const diffWords = (
  before: string,
  after: string
): { removed: [number, number][]; added: [number, number][] } => {
  const none = { removed: [], added: [] }
  if (before === after) return none
  const ops = diffLines(before.match(TOKEN) ?? [], after.match(TOKEN) ?? [])
  if (!similar(before, after, ops)) return none

  const removed: [number, number][] = []
  const added: [number, number][] = []
  let i = 0
  let j = 0
  const push = (spans: [number, number][], start: number, end: number) => {
    const last = spans[spans.length - 1]
    if (last && last[1] === start) last[1] = end
    else spans.push([start, end])
  }
  for (const op of ops) {
    if (op.kind === "equal") {
      i += op.line.length
      j += op.line.length
    } else if (op.kind === "remove") {
      push(removed, i, i + op.line.length)
      i += op.line.length
    } else {
      push(added, j, j + op.line.length)
      j += op.line.length
    }
  }
  return { removed, added }
}

export const layoutDiff = (
  original: string,
  edited: string,
  streaming = false,
  realLines = false
): DiffLayout => {
  // realLines: the original is whole document lines, so "" is one blank line, not zero lines.
  const oldLines = original || realLines ? original.split("\n") : []
  const newLines = edited ? edited.split("\n") : []
  const partial = streaming ? newLines.pop() || undefined : undefined
  let tail = ""
  if (!oldLines.length && !streaming && newLines[newLines.length - 1] === "") {
    newLines.pop()
    tail = "\n"
  }

  const ops = diffLines(oldLines, newLines)
  if (partial !== undefined) ops.push(add(partial))

  const lines: string[] = []
  const removed: number[] = []
  const added: number[] = []
  for (const { kind, line } of ops) {
    if (kind === "remove") removed.push(lines.length)
    if (kind === "add") added.push(lines.length)
    lines.push(line)
  }
  const words = highlightWords(ops, partial !== undefined)
  return { text: lines.join("\n") + tail, removed, added, ...words }
}

const similar = (before: string, after: string, ops: DiffOp[]) => {
  const shared = ops
    .filter((op) => op.kind === "equal" && op.line.trim())
    .reduce((n, op) => n + op.line.length, 0)
  return shared * 2 >= Math.min(before.trim().length, after.trim().length)
}

const highlightWords = (ops: DiffOp[], skipLast: boolean) => {
  const removedWords: Span[] = []
  const addedWords: Span[] = []
  const end = skipLast ? ops.length - 1 : ops.length
  let i = 0
  while (i < end) {
    if (ops[i].kind !== "remove") {
      i++
      continue
    }
    const removes: number[] = []
    while (i < end && ops[i].kind === "remove") removes.push(i++)
    const adds: number[] = []
    while (i < end && ops[i].kind === "add") adds.push(i++)

    const candidates: { remove: number; add: number; score: number }[] = []
    for (const remove of removes) {
      for (const add of adds) {
        const score = likeness(ops[remove].line, ops[add].line)
        if (score > 0) candidates.push({ remove, add, score })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    const taken = new Set<number>()
    for (const { remove, add } of candidates) {
      if (taken.has(remove) || taken.has(add)) continue
      taken.add(remove)
      taken.add(add)
      const words = diffWords(ops[remove].line, ops[add].line)
      for (const [start, stop] of words.removed) {
        removedWords.push({ line: remove, start, end: stop })
      }
      for (const [start, stop] of words.added) {
        addedWords.push({ line: add, start, end: stop })
      }
    }
  }
  removedWords.sort((a, b) => a.line - b.line || a.start - b.start)
  addedWords.sort((a, b) => a.line - b.line || a.start - b.start)
  return { removedWords, addedWords }
}

const likeness = (before: string, after: string): number => {
  const ops = diffLines(before.match(TOKEN) ?? [], after.match(TOKEN) ?? [])
  if (!similar(before, after, ops)) return 0
  return ops
    .filter((op) => op.kind === "equal" && op.line.trim())
    .reduce((n, op) => n + op.line.length, 0)
}

const ELISION = /^\s*(\/\/|#|--|\/\*|<!--)?\s*(\.\.\.|…)/

export const locateSnippet = (
  fileLines: string[],
  snippet: string[]
): { start: number; end: number } | undefined => {
  const wanted = snippet.filter((line) => line.trim() && !ELISION.test(line))
  if (!wanted.length) return undefined

  let matched = 0
  let first: number | undefined
  let last: number | undefined
  let line = 0
  for (const op of diffLines(fileLines, snippet, true)) {
    if (op.kind === "add") continue
    if (op.kind === "equal" && op.line.trim()) {
      matched++
      first ??= line
      last = line
    }
    line++
  }
  if (first === undefined || last === undefined) return undefined
  if (matched * 2 < wanted.length) return undefined
  return { start: first, end: last }
}
