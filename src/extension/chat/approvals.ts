import { window } from "vscode"

// The extension's own gate for tools that act without per-hunk review (commands, deletes, moves, renames).
// TrueForge's approval policy is the first gate; this one holds even if that policy is missing or bypassed,
// e.g. a caller holding the MCP token. An approval in the panel grants one call of that tool.
// ponytail: counted per tool name, not per call id (the MCP request doesn't carry TrueForge's call id).
const granted = new Map<string, number>()

export const grantTool = (tool: string) => granted.set(tool, (granted.get(tool) ?? 0) + 1)

export const clearGrants = () => granted.clear()

export const allowTool = async (tool: string, what: string): Promise<boolean> => {
  const left = granted.get(tool) ?? 0
  if (left > 0) {
    granted.set(tool, left - 1)
    return true
  }
  const answer = await window.showWarningMessage(`Pointer's agent wants to ${what}.`, { modal: true }, "Allow")
  return answer === "Allow"
}
