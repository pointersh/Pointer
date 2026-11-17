
const normalizeWorkspacePath = (filePath: string): string => {
  const trimmed = filePath.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed
  return trimmed.replace(/^[\\/]+/, "")
}

interface WorkspaceRoot {
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
