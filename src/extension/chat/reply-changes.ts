import { createHash, randomUUID } from "crypto"
import fs from "fs"
import path from "path"

import { FileChangeView } from "../../common/types"
import { diffLines } from "../edit/diff"
import { looksBinary } from "../indexable"

export const MAX_KEPT_FILE_BYTES = 1024 * 1024
const PENDING_WAIT_MS = 5000

export type FileState = string | null | undefined

export interface ChangedFile extends FileChangeView {
  before: string | null
  afterHash: string | null
}

export interface ChangeRecord {
  id: string
  root: string
  createdAt: number
  files: ChangedFile[]
}

export const hashOf = (text: string | null): string | null =>
  text === null ? null : createHash("sha256").update(text).digest("hex")

const linesOf = (text: string | null) => (text === null || text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"))

const counts = (before: string | null, after: string | null) => {
  let added = 0
  let removed = 0
  for (const op of diffLines(linesOf(before), linesOf(after))) {
    if (op.kind === "add") added++
    else if (op.kind === "remove") removed++
  }
  return { added, removed }
}

export const readState = async (
  file: string,
  open?: (file: string) => Promise<string | undefined>
): Promise<FileState> => {
  const editor = await open?.(file)
  if (editor !== undefined) return editor.length > MAX_KEPT_FILE_BYTES ? undefined : editor
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) return undefined
    if (stat.size > MAX_KEPT_FILE_BYTES) return undefined
    const buffer = await fs.promises.readFile(file)
    if (looksBinary(buffer)) return undefined
    const text = buffer.toString("utf8")
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined
  }
}

export class ReplyChanges {
  readonly id = randomUUID()
  private readonly _before = new Map<string, FileState>()
  private readonly _pending = new Set<Promise<unknown>>()

  constructor(
    readonly root: string,
    private readonly _open?: (file: string) => Promise<string | undefined>
  ) {}

  async touch(file: string): Promise<void> {
    const absolute = path.resolve(file)
    if (this._before.has(absolute)) return
    this._before.set(absolute, await readState(absolute, this._open))
  }

  touchWith(file: string, before: FileState): void {
    const absolute = path.resolve(file)
    if (!this._before.has(absolute)) this._before.set(absolute, before)
  }

  get touched(): number {
    return this._before.size
  }

  hold<T>(work: Promise<T>): Promise<T> {
    this._pending.add(work)
    const done = () => this._pending.delete(work)
    work.then(done, done)
    return work
  }

  async record(): Promise<ChangeRecord | undefined> {
    if (this._pending.size) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...this._pending]),
        new Promise((resolve) => (timer = setTimeout(resolve, PENDING_WAIT_MS)))
      ])
      clearTimeout(timer)
    }
    const files: ChangedFile[] = []
    for (const [absolute, before] of this._before) {
      const after = await readState(absolute, this._open)
      if (before !== undefined && after !== undefined && before === after) continue
      if (before === null && after === null) continue
      if (before === undefined && after === undefined) continue
      const relative = path.relative(this.root, absolute).split(path.sep).join("/")
      const status = before === null ? "created" : after === null ? "deleted" : "modified"
      const kept = before !== undefined && after !== undefined
      files.push({
        path: relative,
        status,
        ...(kept ? counts(before, after) : { added: 0, removed: 0 }),
        ...(kept ? {} : { noUndo: true }),
        before: before ?? null,
        afterHash: after === undefined ? null : hashOf(after)
      })
    }
    if (!files.length) return undefined
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { id: this.id, root: this.root, createdAt: Date.now(), files }
  }
}
