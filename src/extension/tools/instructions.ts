import fs from "fs"
import path from "path"

import { looksBinary } from "../indexable"

import type { WorkspaceView } from "./view"

export const ROOT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]
export const FOLDER_INSTRUCTION_FILE = "AGENTS.md"
export const MAX_ROOT_INSTRUCTION_CHARS = 8000
export const MAX_FOLDER_INSTRUCTION_CHARS = 4000
const MAX_READ_BYTES = 256 * 1024

export interface InstructionFile {
  path: string
  text: string
}

const relativeTo = (root: string, absolute: string) => path.relative(root, absolute).split(path.sep).join("/")

const readInside = (realRoot: string, absolute: string, limit: number): string | undefined => {
  try {
    const real = fs.realpathSync(absolute)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined
    const stat = fs.statSync(real)
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return undefined
    const buffer = fs.readFileSync(real)
    if (looksBinary(buffer)) return undefined
    const raw = buffer.toString("utf8")
    const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim()
    if (!text) return undefined
    return text.length > limit ? `${text.slice(0, limit)}\n… (cut: the file goes on for ${text.length - limit} more characters)` : text
  } catch {
    return undefined
  }
}

export const readRootInstructions = (root: string): InstructionFile | undefined => {
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    return undefined
  }
  for (const name of ROOT_INSTRUCTION_FILES) {
    const text = readInside(realRoot, path.join(root, name), MAX_ROOT_INSTRUCTION_CHARS)
    if (text) return { path: name, text }
  }
  return undefined
}

export const instructionsSection = (file: InstructionFile) =>
  `The project's instructions for coding agents, from ${file.path}. Follow them unless the user asks otherwise:\n\n${file.text}`

export const folderInstructionsNote = (file: InstructionFile) => {
  const folder = path.posix.dirname(file.path)
  return `[${file.path}: the project's instructions for work under ${folder}/. Follow them; where they differ from instructions for a folder above, these win.]\n${file.text}`
}

export class FolderInstructions {
  private readonly _checked = new Set<string>()
  private readonly _given: string[] = []
  private readonly _realRoot: string

  constructor(private readonly _view: WorkspaceView) {
    this._realRoot = fs.realpathSync(_view.root)
  }

  get given(): string[] {
    return [...this._given]
  }

  for(target: string): InstructionFile[] {
    const cleaned = target.trim().replace(/^\.\/+/, "")
    if (!cleaned) return []
    const absolute = path.resolve(this._view.root, cleaned)
    const relative = relativeTo(this._view.root, absolute)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return []
    let folder = absolute
    try {
      if (!fs.statSync(absolute).isDirectory()) folder = path.dirname(absolute)
    } catch {
      folder = path.dirname(absolute)
    }
    const found: InstructionFile[] = []
    while (folder !== this._view.root && folder.startsWith(this._view.root + path.sep)) {
      const file = path.join(folder, FOLDER_INSTRUCTION_FILE)
      const rel = relativeTo(this._view.root, file)
      if (!this._checked.has(rel)) {
        this._checked.add(rel)
        const text = this._view.ignored(relativeTo(this._view.root, folder), true)
          ? undefined
          : readInside(this._realRoot, file, MAX_FOLDER_INSTRUCTION_CHARS)
        if (text) found.unshift({ path: rel, text })
      }
      folder = path.dirname(folder)
    }
    this._given.push(...found.map((file) => file.path))
    return found
  }
}
