import { ContextItem } from "../types"

export const EXTENSION_NAME = "@ext:pointer.pointer"
export const DEFAULT_AGENT_STEPS = 30
export const AGENT_STEP_PRESETS = [12, 20, 30, 40]
export const ASSISTANT = "assistant"
export const USER = "user"
export const POINTER = "pointer"
export const SYSTEM = "system"
export const YOU = "You"
export const OPENING_BRACKETS = ["[", "{", "("]
export const CLOSING_BRACKETS = ["]", "}", ")"]
export const ALL_BRACKETS = [...OPENING_BRACKETS, ...CLOSING_BRACKETS] as const
export const NORMALIZE_REGEX = /\s*\r?\n|\r/g
export const DEFAULT_RERANK_THRESHOLD = 0.08
export const POINTER_PROVIDERS_FILENAME = "pointer-providers.json"

export const defaultChunkOptions = {
  maxSize: 1000,
  minSize: 100,
  overlap: 100
}

export const TITLE_GENERATION_PROMPT_MESAGE = `
  Generate a title for this conversation in under 10 words.
  It should not contain any special characters or quotes.
`

export const DEFAULT_RELEVANT_CODE_COUNT = 6
export const DEFAULT_WORKSPACE_CONTEXT_CHARS = 12000
export const DEFAULT_WORKSPACE_HIT_CHARS = 3000
export const FIM_MAX_PREFIX_CHARS = 12000
export const FIM_MAX_SUFFIX_CHARS = 3000

export const knownErrorMessages = [
  "First parameter has member 'readable' that is not a ReadableStream.",
  "The 'transform.readable' property must be an instance of ReadableStream. Received an instance of h"
]

export const topLevelItems: ContextItem[] = [
  { name: "workspace", path: "", category: "workspace", id: "workspace" },
  { name: "problems", path: "", category: "problems", id: "problems" },
  { name: "git", path: "", category: "git", id: "git" },
  { name: "terminal", path: "", category: "terminal", id: "terminal" }
]

export const TOP_LEVEL_MENTIONS = new Set(topLevelItems.map((item) => item.name))
