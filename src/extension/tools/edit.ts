import { matchIndentation } from "../edit/prompt"

export interface Replacement {
  startLine: number
  endLine: number
  original: string
  text: string
}

const NUMBERED = /^\s*\d+: ?/

const withoutLineNumbers = (text: string) => {
  const lines = text.split("\n")
  const filled = lines.filter((line) => line.trim())
  if (!filled.length || !filled.every((line) => NUMBERED.test(line))) return text
  const numbers = filled.map((line) => Number.parseInt(line.trim(), 10))
  if (numbers.some((number, i) => i > 0 && number <= numbers[i - 1])) return text
  return lines.map((line) => line.replace(NUMBERED, "")).join("\n")
}

const looksNumbered = (text: string) => text.split("\n").some((line) => NUMBERED.test(line))

const trimBlankEdges = (text: string) =>
  text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "")

const occurrences = (haystack: string, needle: string) => {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at)
  }
  return found
}

const ELLIPSIS = "…"

const sameLine = (fileLine: string, wanted: string) => {
  const have = fileLine.trim()
  const want = wanted.trim()
  if (!want.endsWith(ELLIPSIS)) return have === want
  const start = want.slice(0, -ELLIPSIS.length)
  return have.length > start.length && have.startsWith(start)
}

const looseMatches = (lines: string[], wanted: string[]) => {
  const found: number[] = []
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    if (wanted.every((line, i) => sameLine(lines[start + i], line))) found.push(start)
  }
  return found
}

const inText = (text: string, lines: string[], find: string) =>
  !!find.trim() && (text.includes(find) || looseMatches(lines, find.split("\n")).length > 0)

const restoreCutLines = (replace: string, original: string[]): string | undefined => {
  const lines = replace.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().endsWith(ELLIPSIS)) continue
    const full = original.find((line) => sameLine(line, lines[i]))
    if (full === undefined) return undefined
    lines[i] = (lines[i].match(/^\s*/)?.[0] ?? "") + full.trim()
  }
  return lines.join("\n")
}

const CUT_LINE_REFUSAL =
  "replace has a line cut short with … that is not in find; leave long lines you do not change out of find and replace"

const NOT_FOUND = "find is not in the file; read the lines again and copy them exactly, without the line numbers"

const TO_ADD =
  "To add new code rather than change what is there, put the existing lines it goes next to in find, and those same lines with the new code in replace."

const MAX_HINT_FIND_LINES = 12
const MAX_HINT_FILE_LINES = 20_000
const MIN_LIKENESS = 0.6
const MAX_HINT_LINE_CHARS = 200

const pairsOf = (line: string) => {
  const text = line.trim()
  const pairs = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2)
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1)
  }
  return { text, pairs, size: Math.max(0, text.length - 1) }
}

const likeness = (a: ReturnType<typeof pairsOf>, b: ReturnType<typeof pairsOf>) => {
  if (a.text === b.text) return 1
  if (!a.size || !b.size) return 0
  const [small, large] = a.pairs.size <= b.pairs.size ? [a, b] : [b, a]
  let shared = 0
  for (const [pair, count] of small.pairs) shared += Math.min(count, large.pairs.get(pair) ?? 0)
  return (2 * shared) / (a.size + b.size)
}

const clipped = (line: string) => (line.length > MAX_HINT_LINE_CHARS ? `${line.slice(0, MAX_HINT_LINE_CHARS)}…` : line)

const hintLine = (number: number, line: string) => `${number}: ${clipped(line)}`

const nearestLines = (lines: string[], wanted: string[]): string | undefined => {
  const compared = wanted.slice(0, MAX_HINT_FIND_LINES)
  if (lines.length > MAX_HINT_FILE_LINES || wanted.length > lines.length) return undefined
  const want = compared.map(pairsOf)
  const filled = want.filter((line) => line.text)
  if (!filled.length) return undefined
  const have = lines.map(pairsOf)
  let best = { start: -1, score: 0 }
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    let total = 0
    for (let i = 0; i < compared.length; i++) {
      if (want[i].text) total += likeness(have[start + i], want[i])
    }
    const score = total / filled.length
    if (score > best.score) best = { start, score }
  }
  if (best.start < 0 || best.score < MIN_LIKENESS) return undefined
  const { start } = best
  const end = start + wanted.length - 1
  const different = wanted.filter((line, i) => line.trim() && !sameLine(lines[start + i], line)).length
  if (different > Math.max(1, Math.floor(filled.length / 3))) return undefined
  const differs = wanted.findIndex((line, i) => !sameLine(lines[start + i], line))
  const where =
    differs === -1
      ? ""
      : `, where line ${start + differs + 1} is \`${clipped(lines[start + differs].trim())}\` but find has \`${clipped(wanted[differs].trim())}\``
  const shown = lines
    .slice(Math.max(0, start - 1), Math.min(lines.length, end + 2))
    .map((line, i) => hintLine(Math.max(0, start - 1) + i + 1, line))
  const span = start === end ? `line ${start + 1}` : `lines ${start + 1}–${end + 1}`
  return `The nearest match is ${span}${where}. As they are now:\n${shown.join("\n")}`
}

export const planReplacement = (
  content: string,
  rawFind: string,
  rawReplace: string
): Replacement | string => {
  const text = content.replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  const asWritten = trimBlankEdges(rawFind.replace(/\r\n/g, "\n"))
  const unnumbered = trimBlankEdges(withoutLineNumbers(rawFind.replace(/\r\n/g, "\n")))
  const numbered = unnumbered !== asWritten && !inText(text, lines, asWritten)
  const find = numbered ? unnumbered : asWritten
  const replaceText = rawReplace.replace(/\r\n/g, "\n")
  const stripReplace = numbered || !looksNumbered(asWritten)
  const replace = (stripReplace ? withoutLineNumbers(replaceText) : replaceText).replace(/\n+$/, "")
  if (!find.trim()) return "find is empty; it must be text already in the file"

  const exact = occurrences(text, find)
  if (exact.length > 1) {
    return `find matches ${exact.length} places; include more of the surrounding lines so it matches once`
  }
  if (exact.length === 1) {
    const start = exact[0]
    const startLine = text.slice(0, start).split("\n").length - 1
    const endLine = startLine + find.split("\n").length - 1
    const originalLines = lines.slice(startLine, endLine + 1)
    const original = originalLines.join("\n")
    const restored = restoreCutLines(replace, originalLines)
    if (restored === undefined) return CUT_LINE_REFUSAL
    const column = start - (text.lastIndexOf("\n", start - 1) + 1)
    const edited = original.slice(0, column) + restored + original.slice(column + find.length)
    if (edited === original) return "replace is the same as find; nothing would change"
    return { startLine, endLine, original, text: edited }
  }

  const wanted = find.split("\n")
  const loose = looseMatches(lines, wanted)
  if (loose.length > 1) {
    return `find matches ${loose.length} places; include more of the surrounding lines so it matches once`
  }
  if (!loose.length) {
    const nearest = nearestLines(lines, wanted)
    return nearest
      ? `find is not in the file. ${nearest}\nCopy the lines exactly as they are, without the line numbers. ${TO_ADD}`
      : `${NOT_FOUND}. ${TO_ADD}`
  }
  const startLine = loose[0]
  const endLine = startLine + wanted.length - 1
  const originalLines = lines.slice(startLine, endLine + 1)
  const original = originalLines.join("\n")
  const restored = restoreCutLines(replace, originalLines)
  if (restored === undefined) return CUT_LINE_REFUSAL
  const edited = matchIndentation(restored, original)
  if (edited === original) return "replace is the same as find; nothing would change"
  return { startLine, endLine, original, text: edited }
}

export interface EditRequest {
  find?: string
  replace: string
  all?: boolean
  startLine?: number
  endLine?: number
}

export const planLines = (content: string, start: number, end: number, rawReplace: string): Replacement | string => {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return "start_line and end_line must be line numbers from read_file, with end_line not before start_line"
  }
  if (end > lines.length) return `the file has only ${lines.length} lines`
  const original = lines.slice(start - 1, end).join("\n")
  const text = withoutLineNumbers(rawReplace.replace(/\r\n/g, "\n")).replace(/\n+$/, "")
  if (text === original) return "replace is the same as those lines; nothing would change"
  return { startLine: start - 1, endLine: end - 1, original, text }
}

const replaceEvery = (text: string, find: string, replace: string): { text: string; count: number } => {
  const exact = text.split(find)
  if (exact.length > 1) return { text: exact.join(replace), count: exact.length - 1 }
  const lines = text.split("\n")
  const wanted = find.split("\n")
  const out: string[] = []
  let count = 0
  for (let i = 0; i < lines.length; ) {
    if (i + wanted.length <= lines.length && wanted.every((line, j) => sameLine(lines[i + j], line))) {
      out.push(matchIndentation(replace, lines.slice(i, i + wanted.length).join("\n")))
      i += wanted.length
      count++
    } else {
      out.push(lines[i++])
    }
  }
  return { text: out.join("\n"), count }
}

const withLines = (text: string, plan: Replacement) => {
  const lines = text.split("\n")
  lines.splice(plan.startLine, plan.endLine - plan.startLine + 1, ...(plan.text === "" ? [] : plan.text.split("\n")))
  return lines.join("\n")
}

export const planEdits = (content: string, edits: EditRequest[]): (Replacement & { count: number }) | string => {
  const before = content.replace(/\r\n/g, "\n")
  if (!edits.length) return "there were no edits to make"
  if (edits.length === 1 && !edits[0].all) {
    const [only] = edits
    const plan =
      only.startLine !== undefined
        ? planLines(before, only.startLine, only.endLine ?? only.startLine, only.replace)
        : planReplacement(before, only.find ?? "", only.replace)
    return typeof plan === "string" ? plan : { ...plan, count: 1 }
  }
  let text = before
  let count = 0
  for (const [index, edit] of edits.entries()) {
    const which = edits.length > 1 ? `edit ${index + 1} of ${edits.length}: ` : ""
    if (edit.startLine !== undefined) {
      return `${which}start_line and end_line cannot be used with replace_all or in a list of edits; use find`
    }
    const find = trimBlankEdges(withoutLineNumbers((edit.find ?? "").replace(/\r\n/g, "\n")))
    if (!find.trim()) return `${which}find is empty; it must be text already in the file`
    if (edit.all) {
      const replace = withoutLineNumbers(edit.replace.replace(/\r\n/g, "\n")).replace(/\n+$/, "")
      if (replace === find) return `${which}replace is the same as find; nothing would change`
      const every = replaceEvery(text, find, replace)
      if (!every.count) return `${which}${NOT_FOUND}`
      text = every.text
      count += every.count
      continue
    }
    const plan = planReplacement(text, edit.find ?? "", edit.replace)
    if (typeof plan === "string") return `${which}${plan}${edits.length > 1 ? "\nNone of the edits were made." : ""}`
    text = withLines(text, plan)
    count++
  }
  if (text === before) return "nothing would change"
  const was = before.split("\n")
  const now = text.split("\n")
  let head = 0
  while (head < was.length && head < now.length && was[head] === now[head]) head++
  let tail = 0
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++
  if (head + tail === was.length) {
    if (head > 0) head--
    else tail--
  }
  const startLine = head
  const endLine = was.length - 1 - tail
  return {
    startLine,
    endLine,
    original: was.slice(startLine, endLine + 1).join("\n"),
    text: now.slice(startLine, now.length - tail).join("\n"),
    count
  }
}
