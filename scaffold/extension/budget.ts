
export const DEFAULT_CHARS_PER_TOKEN = 3.3

export const SMALL_CONTEXT_TOKENS = 8192

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export interface ContextPlan {
  window: number
  limit: number
  target: number
  resultChars: number
  notesChars: number
}

export const planContext = (window: number): ContextPlan => {
  const reply = Math.min(2048, Math.floor(window * 0.2))
  const limit = Math.max(512, Math.floor(window * 0.9) - reply)
  return {
    window,
    limit,
    target: Math.floor(limit * 0.65),
    resultChars: clamp(Math.floor(window * DEFAULT_CHARS_PER_TOKEN * 0.2), 2000, 30_000),
    notesChars: clamp(Math.floor(window * DEFAULT_CHARS_PER_TOKEN * 0.08), 1200, 6000)
  }
}

export class TokenEstimator {
  private _charsPerToken = DEFAULT_CHARS_PER_TOKEN

  public tokens(chars: number): number {
    return Math.ceil(chars / this._charsPerToken)
  }

  public observe(chars: number, promptTokens: number | undefined) {
    if (!promptTokens || chars < 200) return
    this._charsPerToken = clamp(chars / promptTokens, 2, 6)
  }

  public get charsPerToken() {
    return this._charsPerToken
  }
}

export const cutToLine = (text: string, max: number): string => {
  if (text.length <= max) return text
  const newline = text.lastIndexOf("\n", max)
  return text.slice(0, newline > max / 2 ? newline : max)
}

export const fitResult = (output: string, maxChars: number): string =>
  output.length <= maxChars
    ? output
    : `${cutToLine(output, maxChars)}\n… cut to fit the model's context (${output.length - maxChars} more characters); ask for less at a time`

export const MIN_TRIMMABLE_CHARS = 500

const TRIMMED_NOTE = "[The rest was trimmed to save context. Run the tool again if you need it.]"

export const trimmedResult = (output: string, digest?: string): string => {
  const kept = digest?.trim() ? digest.trim().slice(0, 500) : output.split("\n", 1)[0].slice(0, 160)
  return `${kept}\n${TRIMMED_NOTE}`
}

interface Turn {
  role: string
  content?: unknown
}

const turnText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n")
      : ""

const FOLD_BLOCK = 8
const HISTORY_SHARE = 0.55
const HISTORY_TARGET = 0.35
const MAX_FOLD_CHARS = 1600

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/```[\s\S]*?(```|$)/g, " (code) ").replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export const FOLD_HEADER = "[Earlier in this conversation, left out to fit the model's context:"

const foldedText = (folded: Turn[]): string => {
  const lines = folded
    .map((turn) => {
      const text = oneLine(turnText(turn.content), turn.role === "user" ? 160 : 200)
      return text ? `- ${turn.role === "user" ? "The user" : "You"}: ${text}` : ""
    })
    .filter(Boolean)
  let dropped = 0
  while (lines.length > 2 && lines.join("\n").length > MAX_FOLD_CHARS) {
    lines.shift()
    dropped++
  }
  return [FOLD_HEADER, ...(dropped ? [`(${dropped} older messages not listed)`] : []), ...lines, "]"].join("\n")
}

export const compactHistory = <T extends Turn>(
  messages: T[],
  plan: ContextPlan,
  tokens: (chars: number) => number = (chars) => Math.ceil(chars / DEFAULT_CHARS_PER_TOKEN)
): { messages: T[]; folded: number } => {
  const sizes = messages.map((message) => turnText(message.content).length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (tokens(total) <= plan.limit * HISTORY_SHARE) return { messages, folded: 0 }
  const first = messages[0]?.role === "system" ? 1 : 0
  const lastIndex = messages.length - 1
  let left = total
  let cut = first
  let whole = true
  while (cut < lastIndex && tokens(left) > plan.limit * HISTORY_TARGET) {
    const next = Math.min(lastIndex, cut + FOLD_BLOCK)
    if (lastIndex - next < 2) {
      whole = false
      break
    }
    for (let i = cut; i < next; i++) left -= sizes[i]
    cut = next
  }
  while (!whole && cut < lastIndex && tokens(left) > plan.limit * HISTORY_SHARE) {
    const next = Math.min(lastIndex, cut + 2)
    for (let i = cut; i < next; i++) left -= sizes[i]
    cut = next
  }
  while (cut < lastIndex && messages[cut].role !== "user") {
    left -= sizes[cut]
    cut++
  }
  if (cut <= first) return { messages, folded: 0 }
  const note = foldedText(messages.slice(first, cut))
  const head = messages[cut]
  const merged = (
    typeof head.content === "string"
      ? { ...head, content: `${note}\n\n${head.content}` }
      : Array.isArray(head.content)
        ? { ...head, content: [{ type: "text", text: note }, ...head.content] }
        : head
  ) as T
  return { messages: [...messages.slice(0, first), merged, ...messages.slice(cut + 1)], folded: cut - first }
}
