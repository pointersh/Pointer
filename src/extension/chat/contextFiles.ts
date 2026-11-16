import { supportedLanguages } from "../../common/languages"

const EXTENSION_TO_LANGUAGE: Record<string, string> = Object.entries(
  supportedLanguages
).reduce<Record<string, string>>((acc, [languageId, details]) => {
  for (const extension of details.fileExtensions) {
    if (!(extension in acc)) acc[extension] = languageId
  }
  return acc
}, {})

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

export const languageForPath = (filePath: string): string => {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return ""
  return EXTENSION_TO_LANGUAGE[filePath.slice(dot).toLowerCase()] || ""
}
