import fs from "fs"
import ignore, { Ignore } from "ignore"
import path from "path"

import { isIndexablePath, looksBinary } from "../indexable"

const MAX_LINE_CHARS = 200
const MAX_FILE_BYTES = 512 * 1024

export const clip = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

export const linesOf = (text: string): string[] => {
  const unix = text.replace(/\r\n/g, "\n")
  return unix === "" ? [] : unix.replace(/\n$/, "").split("\n")
}

const present = (file: string) => {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

export class ToolInputError extends Error {}

export class WorkspaceView {
  private readonly _realRoot: string
  private readonly _base: Ignore
  private readonly _gitignores = new Map<string, Ignore | null>()
  private _files?: Promise<string[]>
  private _tree?: Promise<{ files: string[]; dirs: string[] }>

  private readonly _blocked?: Ignore

  constructor(
    readonly root: string,
    ignoredGlobs: string[] = [],
    private readonly _read?: (file: string) => Promise<string | undefined>,
    blockedGlobs: string[] = []
  ) {
    this._realRoot = fs.realpathSync(root)
    this._base = ignore().add([".git", "node_modules", ...ignoredGlobs])
    if (blockedGlobs.length) this._blocked = ignore().add(blockedGlobs)
  }

  blocked(relative: string, isDirectory = false): boolean {
    if (!this._blocked) return false
    const parts = relative.split(/[\\/]+/).filter(Boolean)
    if (!parts.length || parts[0] === "..") return false
    return this._blocked.ignores(parts.join("/") + (isDirectory ? "/" : ""))
  }

  private gitignoreOf(dir: string): Ignore | null {
    let rules = this._gitignores.get(dir)
    if (rules === undefined) {
      try {
        rules = ignore().add(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"))
      } catch {
        rules = null
      }
      this._gitignores.set(dir, rules)
    }
    return rules
  }

  ignored(relative: string, isDirectory = false): boolean {
    const parts = relative.split(/[\\/]+/).filter(Boolean)
    if (!parts.length || parts[0] === "..") return false
    const whole = parts.join("/") + (isDirectory ? "/" : "")
    if (this._base.ignores(whole) || this._blocked?.ignores(whole)) return true
    for (let depth = 0; depth < parts.length; depth++) {
      const rules = this.gitignoreOf(path.join(this.root, ...parts.slice(0, depth)))
      if (rules?.ignores(parts.slice(depth).join("/") + (isDirectory ? "/" : ""))) return true
    }
    return false
  }

  private inside(real: string) {
    return real === this._realRoot || real.startsWith(this._realRoot + path.sep)
  }

  visible(absolute: string): boolean {
    const relative = path.relative(this.root, absolute)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
    return !this.ignored(relative)
  }

  resolve(relative = ".", kind: "file" | "dir" | "any"): string {
    const cleaned = relative.trim().replace(/^\.\/+/, "") || "."
    let absolute = path.resolve(this.root, cleaned)
    if (path.isAbsolute(cleaned) && !this.inside(absolute) && !fs.existsSync(absolute)) {
      absolute = path.join(this.root, cleaned)
    }
    let real: string
    try {
      real = fs.realpathSync(absolute)
    } catch {
      throw new ToolInputError(`${cleaned} does not exist.`)
    }
    const rel = path.relative(this.root, absolute)
    if (!this.inside(real) || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    const stat = fs.statSync(real)
    const realRel = path.relative(this._realRoot, real)
    if (realRel && realRel !== rel && this.ignored(realRel, stat.isDirectory())) {
      throw new ToolInputError(
        this.blocked(realRel, stat.isDirectory())
          ? `${cleaned} leads to a path the team's rules keep from the agent, and cannot be read.`
          : `${cleaned} leads to a path ignored by .gitignore and cannot be read.`
      )
    }
    if (rel && this.ignored(rel, stat.isDirectory())) {
      throw new ToolInputError(
        this.blocked(rel, stat.isDirectory())
          ? `${cleaned} is kept from the agent by the team's rules and cannot be read.`
          : `${cleaned} is ignored by .gitignore and cannot be read.`
      )
    }
    if (kind === "file" && !stat.isFile()) throw new ToolInputError(`${cleaned} is not a file.`)
    if (kind === "dir" && !stat.isDirectory()) throw new ToolInputError(`${cleaned} is not a directory.`)
    return absolute
  }

  resolveNew(relative = ""): string {
    const cleaned = relative.trim().replace(/^\.\/+/, "")
    if (!cleaned || /[\\/]$/.test(cleaned)) throw new ToolInputError("A file path is needed, not a folder.")
    const absolute = path.resolve(this.root, cleaned)
    const rel = path.relative(this.root, absolute)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    if (present(absolute)) {
      throw new ToolInputError(`${cleaned} already exists; use edit_file to change it.`)
    }
    let parent = path.dirname(absolute)
    while (!present(parent)) parent = path.dirname(parent)
    let realParent: string
    try {
      realParent = fs.realpathSync(parent)
    } catch {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    if (!this.inside(realParent)) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    if (this.ignored(rel)) {
      throw new ToolInputError(
        this.blocked(rel)
          ? `${cleaned} is kept from the agent by the team's rules; pointer does not write there.`
          : `${cleaned} is ignored by .gitignore; pointer does not write there.`
      )
    }
    return absolute
  }

  forgetFiles() {
    this._files = undefined
    this._tree = undefined
  }

  relative(absolute: string) {
    return path.relative(this.root, absolute).split(path.sep).join("/") || "."
  }

  realRelative(absolute: string): string {
    let existing = absolute
    const rest: string[] = []
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      rest.unshift(path.basename(existing))
      existing = path.dirname(existing)
    }
    try {
      const real = path.join(fs.realpathSync(existing), ...rest)
      return path.relative(this._realRoot, real).split(path.sep).join("/") || "."
    } catch {
      return this.relative(absolute)
    }
  }

  entries(dir: string): { name: string; dir: boolean }[] {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((dirent) => !this.ignored(path.relative(this.root, path.join(dir, dirent.name)), dirent.isDirectory()))
      .map((dirent) => ({ name: dirent.name, dir: dirent.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  }

  files(): Promise<string[]> {
    this._files ??= this.tree().then(({ files }) => files.filter(isIndexablePath))
    return this._files
  }

  allFiles(): Promise<string[]> {
    return this.tree().then(({ files }) => files)
  }

  allDirs(): Promise<string[]> {
    return this.tree().then(({ dirs }) => dirs)
  }

  private tree() {
    this._tree ??= this.walk()
    return this._tree
  }

  private async walk() {
    const files: string[] = []
    const dirs: string[] = []
    const visit = async (dir: string) => {
      let dirents: fs.Dirent[]
      try {
        dirents = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        const entry = path.join(dir, dirent.name)
        if (this.ignored(path.relative(this.root, entry), dirent.isDirectory())) continue
        if (dirent.isDirectory()) {
          dirs.push(entry)
          await visit(entry)
        } else if (dirent.isFile()) {
          files.push(entry)
        }
      }
    }
    await visit(this.root)
    return { files: files.sort(), dirs: dirs.sort() }
  }

  async text(file: string): Promise<string | undefined> {
    const open = await this._read?.(file)
    if (open !== undefined) return open
    try {
      const stat = await fs.promises.stat(file)
      if (stat.size > MAX_FILE_BYTES) return undefined
      const buffer = await fs.promises.readFile(file)
      if (looksBinary(buffer)) return undefined
      const text = buffer.toString("utf8")
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    } catch {
      return undefined
    }
  }
}
