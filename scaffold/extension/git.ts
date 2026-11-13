import { exec } from "child_process"
import * as util from "util"

const execAsync = util.promisify(exec)

const MAX_BUFFER = 32 * 1024 * 1024

export const runGit = async (cwd: string, args: string): Promise<string> => {
  const { stdout } = await execAsync(`git ${args}`, {
    cwd,
    maxBuffer: MAX_BUFFER
  })
  return stdout
}

const tryGit = async (cwd: string, args: string): Promise<string | undefined> =>
  runGit(cwd, args).then(
    (out) => out,
    () => undefined
  )

export const isGitRepository = async (cwd: string): Promise<boolean> =>
  (await tryGit(cwd, "rev-parse --is-inside-work-tree"))?.trim() === "true"

export const getWorkingTreeDiff = async (cwd: string): Promise<string> => {
  const hasHead = await tryGit(cwd, "rev-parse --verify --quiet HEAD")
  if (hasHead?.trim()) return runGit(cwd, "diff HEAD")
  return runGit(cwd, "diff --cached")
}

export const truncateDiff = (diff: string, maxChars = 24_000): string => {
  if (diff.length <= maxChars) return diff
  const head = diff.slice(0, maxChars)
  const boundary = Math.max(head.lastIndexOf("\ndiff --git "), head.lastIndexOf("\n@@ "))
  const kept = boundary > maxChars / 2 ? head.slice(0, boundary) : head
  return `${kept.trimEnd()}\n\n[diff truncated: ${diff.length - kept.length} more characters not shown]`
}
