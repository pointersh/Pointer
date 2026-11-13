import { createHash, randomUUID } from "crypto"
import fs from "fs"
import path from "path"

import { FileChangeView, ReplyChangesView } from "../../common/types"
import { diffLines } from "../edit/diff"
import { looksBinary } from "../indexable"

export const MAX_KEPT_FILE_BYTES = 1024 * 1024
export const MAX_KEPT_REPLIES = 50
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

export const viewOf = (record: ChangeRecord): ReplyChangesView => ({
  id: record.id,
  files: record.files.map(({ path: file, status, added, removed, undone, noUndo }) => ({
    path: file,
    status,
    added,
    removed,
    ...(undone ? { undone } : {}),
    ...(noUndo ? { noUndo } : {})
  }))
})

export interface UndoStep {
  path: string
  absolute: string
  restore: string | null
  drifted: boolean
}

export const planUndo = async (
  record: ChangeRecord,
  paths: string[] | undefined,
  open?: (file: string) => Promise<string | undefined>
): Promise<UndoStep[]> => {
  const steps: UndoStep[] = []
  for (const file of record.files) {
    if (file.undone || file.noUndo || (paths && !paths.includes(file.path))) continue
    const absolute = path.join(record.root, ...file.path.split("/"))
    const now = await readState(absolute, open)
    steps.push({
      path: file.path,
      absolute,
      restore: file.before,
      drifted: now === undefined || hashOf(now) !== file.afterHash
    })
  }
  return steps
}

export class ChangeStore {
  constructor(
    private readonly _dir: string,
    private readonly _max = MAX_KEPT_REPLIES
  ) {}

  private fileOf(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Not a change id.")
    return path.join(this._dir, `${id}.json`)
  }

  save(record: ChangeRecord): void {
    fs.mkdirSync(this._dir, { recursive: true })
    fs.writeFileSync(this.fileOf(record.id), JSON.stringify(record))
    this.prune()
  }

  load(id: string): ChangeRecord | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.fileOf(id), "utf8")) as ChangeRecord
    } catch {
      return undefined
    }
  }

  markUndone(id: string, paths: string[]): ChangeRecord | undefined {
    const record = this.load(id)
    if (!record) return undefined
    for (const file of record.files) if (paths.includes(file.path)) file.undone = true
    fs.writeFileSync(this.fileOf(id), JSON.stringify(record))
    return record
  }

  private prune() {
    let names: string[]
    try {
      names = fs.readdirSync(this._dir).filter((name) => name.endsWith(".json"))
    } catch {
      return
    }
    if (names.length <= this._max) return
    const aged = names
      .map((name) => ({ name, at: fs.statSync(path.join(this._dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const { name } of aged.slice(this._max)) fs.rmSync(path.join(this._dir, name), { force: true })
  }
}
