import { supportedLanguages } from "../../common/languages"

export interface ContextEntry {
  path: string
  content: string
  range?: { startLine: number; endLine: number }
}

export interface ContextBudget {
  maxEntryChars: number
  maxTotalChars: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxEntryChars: 60000,
  maxTotalChars: 160000
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = Object.entries(
  supportedLanguages
).reduce<Record<string, string>>((acc, [languageId, details]) => {
  for (const extension of details.fileExtensions) {
    if (!(extension in acc)) acc[extension] = languageId
  }
  return acc
}, {})

export const normalizeWorkspacePath = (filePath: string): string => {
  const trimmed = filePath.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed
  return trimmed.replace(/^[\\/]+/, "")
}

export interface WorkspaceRoot {
  name: string
  fsPath: string
}

export const workspacePathCandidates = (
  filePath: string,
  roots: WorkspaceRoot[]
): string[] => {
  const relative = normalizeWorkspacePath(filePath)
  if (!relative) return []
  const join = (root: string, rest: string) =>
    `${root.replace(/[\\/]+$/, "")}/${rest}`
  const candidates: string[] = []
  for (const root of roots) {
    const match = relative.slice(root.name.length, root.name.length + 1)
    if (relative.startsWith(root.name) && (match === "/" || match === "\\")) {
      candidates.push(join(root.fsPath, relative.slice(root.name.length + 1)))
    }
  }
  for (const root of roots) candidates.push(join(root.fsPath, relative))
  if (/^([\\/]|[A-Za-z]:[\\/])/.test(filePath.trim())) {
    candidates.push(filePath.trim())
  }
  return [...new Set(candidates)]
}

export const languageForPath = (filePath: string): string => {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return ""
  return EXTENSION_TO_LANGUAGE[filePath.slice(dot).toLowerCase()] || ""
}

const entryKey = (entry: ContextEntry) =>
  entry.range
    ? `${entry.path}:${entry.range.startLine}-${entry.range.endLine}`
    : entry.path

export const dedupeContextEntries = (
  entries: ContextEntry[]
): ContextEntry[] => {
  const wholeFiles = new Set(
    entries.filter((entry) => !entry.range).map((entry) => entry.path)
  )
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (entry.range && wholeFiles.has(entry.path)) return false
    const key = entryKey(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const fence = (content: string) => {
  const longest = Math.max(
    2,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length)
  )
  return "`".repeat(longest + 1)
}

const formatEntry = (entry: ContextEntry, content: string): string => {
  const language = languageForPath(entry.path)
  const heading = entry.range
    ? `${entry.path} (lines ${entry.range.startLine + 1}-${
        entry.range.endLine + 1
      })`
    : `File: ${entry.path}`
  const ticks = fence(content)
  return `${heading}\n${ticks}${language}\n${content}\n${ticks}`
}

export const formatContextEntries = (
  entries: ContextEntry[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET
): string => {
  const blocks: string[] = []
  let remaining = budget.maxTotalChars
  let dropped = 0

  for (const entry of dedupeContextEntries(entries)) {
    if (!entry.content.trim()) continue

    const limit = Math.min(budget.maxEntryChars, remaining)
    if (limit <= 0) {
      dropped++
      continue
    }

    const kept = Math.min(entry.content.length, limit)
    let content = entry.content
    if (kept < content.length) {
      content =
        content.slice(0, kept) +
        `\n[truncated: ${entry.content.length - kept} more characters not shown]`
    }

    blocks.push(formatEntry(entry, content))
    remaining -= kept
  }

  if (dropped > 0) {
    blocks.push(
      `[${dropped} more attached ${
        dropped === 1 ? "file was" : "files were"
      } left out to fit the context window]`
    )
  }

  return blocks.join("\n\n")
}
