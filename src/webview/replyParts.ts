import { ToolStepView } from "../common/types"

type ReplyPart = { text: string } | { steps: ToolStepView[] }

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/

interface Fence {
  char: string
  size: number
  wrapper: boolean
}

const CALL_FENCES = new Set(["", "json", "tool", "xml"])

const opens = (line: string): Fence | undefined => {
  const match = line.match(FENCE_OPEN)
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return undefined
  return { char: match[1][0], size: match[1].length, wrapper: CALL_FENCES.has(match[2].trim().toLowerCase()) }
}

const closes = (line: string, fence: Fence) => {
  const match = line.match(FENCE_CLOSE)
  return !!match && match[1][0] === fence.char && match[1].length >= fence.size
}

const outsideFence = (text: string, at: number) => {
  let open: Fence | undefined
  let written = false
  let offset = 0
  for (const line of text.split("\n")) {
    const end = offset + line.length
    if (offset < at) {
      if (!open) {
        open = opens(line)
        written = false
      } else if (closes(line, open)) {
        open = undefined
      } else if (line.trim()) {
        written = true
      }
    } else if (!open || (open.wrapper && !written)) {
      return at
    } else if (closes(line, open)) {
      return end
    }
    offset = end + 1
  }
  return at
}

export const replyParts = (text: string, steps?: ToolStepView[]): ReplyPart[] => {
  if (!steps?.length) return [{ text }]
  const groups = new Map<number, ToolStepView[]>()
  for (const step of steps) {
    const at = outsideFence(text, Math.min(Math.max(step.at ?? 0, 0), text.length))
    groups.set(at, [...(groups.get(at) ?? []), step])
  }
  const parts: ReplyPart[] = []
  let from = 0
  for (const at of [...groups.keys()].sort((a, b) => a - b)) {
    if (at > from) parts.push({ text: text.slice(from, at) })
    parts.push({ steps: groups.get(at)! })
    from = at
  }
  if (from < text.length) parts.push({ text: text.slice(from) })
  return parts
}
