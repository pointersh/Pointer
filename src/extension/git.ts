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

export const getCurrentBranch = async (cwd: string): Promise<string> =>
  (await tryGit(cwd, "rev-parse --abbrev-ref HEAD"))?.trim() || "HEAD"

const BASE_CANDIDATES = [
  "origin/main",
  "main",
  "origin/master",
  "master",
  "origin/develop",
  "develop",
  "origin/development",
  "development"
]

export interface GitHubRemote {
  owner: string
  repo: string
}

export const parseGitHubRemote = (url: string): GitHubRemote | undefined => {
  const match =
    /(?:^|[/@])github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (!match) return undefined
  return { owner: match[1], repo: match[2] }
}

export const getGitHubRemote = async (
  cwd: string
): Promise<GitHubRemote | undefined> => {
  const origin = await tryGit(cwd, "remote get-url origin")
  if (origin?.trim()) return parseGitHubRemote(origin)
  const remotes = (await tryGit(cwd, "remote -v")) || ""
  for (const line of remotes.split("\n")) {
    const url = line.split(/\s+/)[1]
    const parsed = url && parseGitHubRemote(url)
    if (parsed) return parsed
  }
  return undefined
}

const getRemoteDefaultBranch = async (
  cwd: string
): Promise<string | undefined> => {
  const ref = await tryGit(cwd, "symbolic-ref --quiet refs/remotes/origin/HEAD")
  const name = ref?.trim().replace(/^refs\/remotes\//, "")
  return name || undefined
}

export const detectBaseBranch = async (
  cwd: string
): Promise<string | undefined> => {
  const current = await getCurrentBranch(cwd)
  const remoteDefault = await getRemoteDefaultBranch(cwd)
  const candidates = remoteDefault
    ? [remoteDefault, ...BASE_CANDIDATES]
    : BASE_CANDIDATES
  for (const candidate of candidates) {
    const short = candidate.replace(/^origin\//, "")
    if (short === current) continue
    const exists = await tryGit(cwd, `rev-parse --verify --quiet ${candidate}`)
    if (exists?.trim()) return candidate
  }
  return undefined
}

export const getWorkingTreeDiff = async (cwd: string): Promise<string> => {
  const hasHead = await tryGit(cwd, "rev-parse --verify --quiet HEAD")
  if (hasHead?.trim()) return runGit(cwd, "diff HEAD")
  return runGit(cwd, "diff --cached")
}

export const getBranchDiff = async (
  cwd: string,
  base: string
): Promise<string> => runGit(cwd, `diff ${base}...HEAD`)

export const countChangedFiles = async (
  cwd: string,
  args: string
): Promise<number> => {
  const out = await tryGit(cwd, `diff --name-only ${args}`)
  if (out === undefined) return 0
  return out.split("\n").filter((line) => line.trim()).length
}

export const truncateDiff = (diff: string, maxChars = 24_000): string => {
  if (diff.length <= maxChars) return diff
  const head = diff.slice(0, maxChars)
  const boundary = Math.max(head.lastIndexOf("\ndiff --git "), head.lastIndexOf("\n@@ "))
  const kept = boundary > maxChars / 2 ? head.slice(0, boundary) : head
  return `${kept.trimEnd()}\n\n[diff truncated: ${diff.length - kept.length} more characters not shown]`
}
