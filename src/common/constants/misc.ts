import { ContextItem } from "../types"

export const EXTENSION_NAME = "@ext:pointer.pointer"
export const URL_TEAMS = "https://github.com/pointersh/Pointer/#teams"
export const URL_TEAM_TRIAL = "https://github.com/pointersh/Pointer/#trial"
export const TEAM_QUICKSTART_COMMAND = "npx pointer-server quickstart"
export const DEFAULT_AGENT_STEPS = 30
export const AGENT_STEP_PRESETS = [12, 20, 30, 40]
export const ASSISTANT = "assistant"
export const USER = "user"
export const POINTER = "pointer"
export const SYSTEM = "system"
export const YOU = "You"
export const EMPTY_MESAGE = "Sorry, I don’t understand. Please try again."
export const MODEL_ERROR = "Sorry, something went wrong..."
export const OPENING_BRACKETS = ["[", "{", "("]
export const CLOSING_BRACKETS = ["]", "}", ")"]
export const QUOTES = ["\"", "'", "`"]
export const ALL_BRACKETS = [...OPENING_BRACKETS, ...CLOSING_BRACKETS] as const
export const NORMALIZE_REGEX = /\s*\r?\n|\r/g
export const FILE_NAME_REGEX =
  /(?:^|\s|`)(?:@\/|\.\/|(?:[\w-]+\/)*)?\.?[\w.-]+\.(?:jsx?|tsx?|css|s[ac]ss|less|styl|html?|json|jsonc|md|markdown|py|ipynb|java|class|jar|cpp|hpp|cc|hh|c|h|rs|go|php|rb|swift|kt|gradle|m|mm|cs|fs|fsx|elm|lua|sql|ya?ml|toml|xml|conf|ini|env|sh|bash|zsh|ps1|bat|cmd|txt|log|text|doc|rtf|pdf|lock|editorconfig|gitignore|eslintrc|prettier|babelrc|d\.ts|test\.tsx?|spec\.tsx?|snap|svg|graphql|gql|proto|vue|svelte|astro|razor|cshtml|aspx?|jsx?\.map|tsx?\.map|min\.js|chunk\.js|bundle\.js)(?=\s|$|`)/g
export const QUOTES_REGEX = /["'`]/g
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

export const FIM_MAX_EMPTY_COMPLETION_CHARS = 250
export const FIM_MAX_CONTEXT_FILES = 3
export const FIM_MAX_CONTEXT_CHARS = 6000
export const FIM_CONTEXT_WINDOW_LINES = 100
export const FIM_MAX_PREFIX_CHARS = 12000
export const FIM_MAX_SUFFIX_CHARS = 3000
export const FIM_STREAM_TIMEOUT_MS = 30000

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
