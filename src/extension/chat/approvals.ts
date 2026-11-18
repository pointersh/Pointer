import { window } from "vscode"

// The extension's own gate for tools that act without per-hunk review (commands, deletes, moves, renames).
// TrueForge's approval policy is the first gate; this one holds even if that policy is missing or bypassed,
// e.g. a caller holding the MCP token. An approval in the panel grants one call of that tool.
// ponytail: counted per tool name (plus the exact command for run_command), not per call id (the MCP request doesn't carry TrueForge's call id).
const granted = new Map<string, number>()
const keyOf = (tool: string, detail?: string) => (detail === undefined ? tool : `${tool}\0${detail}`)

export const grantTool = (tool: string, detail?: string) => {
  const key = keyOf(tool, detail)
  granted.set(key, (granted.get(key) ?? 0) + 1)
}

export const clearGrants = () => granted.clear()

export const allowTool = async (tool: string, what: string, detail?: string): Promise<boolean> => {
  const key = keyOf(tool, detail)
  const left = granted.get(key) ?? 0
  if (left > 0) {
    granted.set(key, left - 1)
    return true
  }
  const answer = await window.showWarningMessage(`Pointer's agent wants to ${what}.`, { modal: true }, "Allow")
  return answer === "Allow"
}
