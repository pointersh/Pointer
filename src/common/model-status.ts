
export type ModelPlace =
  | "machine"
  | "network"
  | "gateway"
  | "peer"
  | "hosted"

export interface ModelStatus {
  place: ModelPlace
  host?: string
  loaded?: boolean
  canLoad?: boolean
  contextWindow?: number
  gpuShare?: number
  loadMs?: number
  loading?: boolean
  loadError?: string
}

export const STARTERS = ["explain", "bugs", "tests"] as const
export type StarterKind = (typeof STARTERS)[number]

const DRAFT_CHARS_PER_TOKEN = 3.5
export const CONTEXT_FILLING = 0.8

export interface ContextFit {
  tokens: number
  share: number
  state: "room" | "filling" | "over"
}

export const contextFit = (
  conversationTokens: number,
  draftChars: number,
  contextWindow: number | undefined
): ContextFit | undefined => {
  if (!contextWindow || contextWindow <= 0) return undefined
  const tokens = Math.round(Math.max(0, conversationTokens) + Math.max(0, draftChars) / DRAFT_CHARS_PER_TOKEN)
  const share = tokens / contextWindow
  return { tokens, share, state: share > 1 ? "over" : share >= CONTEXT_FILLING ? "filling" : "room" }
}

export const shortTokens = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  if (tokens % 1024 === 0) return `${tokens / 1024}k`
  return `${tokens >= 10_000 ? Math.round(tokens / 1000) : Math.round(tokens / 100) / 10}k`
}
