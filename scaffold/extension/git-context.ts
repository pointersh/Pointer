import { getWorkingTreeDiff, isGitRepository, runGit, truncateDiff } from "../git"

export const GIT_CONTEXT_MAX_CHARS = 16000

export interface GitSnapshot {
  branch: string
  status: string
  diff: string
}

export const formatGitSnapshot = (
  snapshot: GitSnapshot,
  maxChars = GIT_CONTEXT_MAX_CHARS
): string => {
  const parts = [`Git branch: ${snapshot.branch}`]
  const status = snapshot.status.replace(/\s+$/, "")
  parts.push(
    status
      ? `Changed files:\n\`\`\`\n${status}\n\`\`\``
      : "Changed files: none (working tree clean)"
  )
  const diff = snapshot.diff.trim()
  if (diff) {
    parts.push(
      `Working tree diff:\n\`\`\`diff\n${truncateDiff(diff, maxChars)}\n\`\`\``
    )
  }
  return parts.join("\n\n")
}

export const getGitContext = async (
  cwd: string
): Promise<string | undefined> => {
  if (!(await isGitRepository(cwd))) return undefined
  const [branch, status, diff] = await Promise.all([
    runGit(cwd, "rev-parse --abbrev-ref HEAD").then(
      (out) => out.trim(),
      () => "HEAD"
    ),
    runGit(cwd, "status --short").catch(() => ""),
    getWorkingTreeDiff(cwd).catch(() => "")
  ])
  return formatGitSnapshot({ branch, status, diff })
}
