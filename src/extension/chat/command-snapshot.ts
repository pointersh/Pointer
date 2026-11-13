import { execFile } from "child_process"
import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"

import { looksBinary } from "../indexable"

import { MAX_KEPT_FILE_BYTES } from "./reply-changes"

const GIT_TIMEOUT_MS = 15_000
export const MAX_COMMAND_CHANGES = 200

interface GitAnswer {
  stdout: Buffer
  ok: boolean
}

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<GitAnswer>((resolve) => {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => resolve({ stdout: stdout as Buffer, ok: !error })
    )
    child.stdin?.end()
  })

const repositoryOf = async (cwd: string) => {
  const answer = await git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"])
  if (!answer.ok) return undefined
  const [top, gitDir] = answer.stdout.toString("utf8").trim().split("\n")
  return top && gitDir ? { top, gitDir } : undefined
}

export interface TreeSnapshot {
  top: string
  tree: string
}

export const snapshotTree = async (cwd: string): Promise<TreeSnapshot | undefined> => {
  const repository = await repositoryOf(cwd)
  if (!repository) return undefined
  const index = path.join(os.tmpdir(), `pointer-index-${randomUUID()}`)
  try {
    try {
      fs.copyFileSync(path.join(repository.gitDir, "index"), index)
    } catch {}
    const env = { GIT_INDEX_FILE: index }
    if (!(await git(repository.top, ["add", "-A"], env)).ok) return undefined
    const written = await git(repository.top, ["write-tree"], env)
    const tree = written.stdout.toString("utf8").trim()
    return written.ok && /^[0-9a-f]{40,64}$/.test(tree) ? { top: repository.top, tree } : undefined
  } finally {
    fs.rmSync(index, { force: true })
  }
}

export interface TreeChange {
  file: string
  before: string | null | undefined
}

const textAt = async (top: string, tree: string, relative: string): Promise<string | undefined> => {
  const answer = await git(top, ["cat-file", "-p", `${tree}:${relative}`])
  if (!answer.ok || answer.stdout.length > MAX_KEPT_FILE_BYTES || looksBinary(answer.stdout)) return undefined
  const text = answer.stdout.toString("utf8")
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export const changesBetween = async (before: TreeSnapshot, after: TreeSnapshot): Promise<TreeChange[] | undefined> => {
  if (before.tree === after.tree) return []
  const answer = await git(before.top, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", before.tree, after.tree])
  if (!answer.ok) return []
  const fields = answer.stdout.toString("utf8").split("\0").filter(Boolean)
  const entries: { status: string; relative: string }[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) entries.push({ status: fields[i], relative: fields[i + 1] })
  if (entries.length > MAX_COMMAND_CHANGES) return undefined
  const changes: TreeChange[] = []
  for (const { status, relative } of entries) {
    changes.push({
      file: path.join(before.top, ...relative.split("/")),
      before: status.startsWith("A") ? null : await textAt(before.top, before.tree, relative)
    })
  }
  return changes
}
