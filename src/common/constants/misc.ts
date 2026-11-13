import { ContextItem } from "../types"

export const EXTENSION_NAME = "@ext:pointer.pointer"
export const DEFAULT_AGENT_STEPS = 30
export const AGENT_STEP_PRESETS = [12, 20, 30, 40]
export const ASSISTANT = "assistant"
export const USER = "user"
export const POINTER = "pointer"
export const SYSTEM = "system"
export const YOU = "You"

export const topLevelItems: ContextItem[] = [
  { name: "workspace", path: "", category: "workspace", id: "workspace" },
  { name: "problems", path: "", category: "problems", id: "problems" },
  { name: "git", path: "", category: "git", id: "git" },
  { name: "terminal", path: "", category: "terminal", id: "terminal" }
]
