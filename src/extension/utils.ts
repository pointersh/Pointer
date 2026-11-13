import fs from "fs"
import ignore from "ignore"
import path from "path"
import {
ColorThemeKind,Terminal,window,
workspace
} from "vscode"

import { POINTER } from "../common/constants"
import { supportedLanguages } from "../common/languages"
import { LanguageType, Theme } from "../common/types"

import { isIndexablePath } from "./indexable"

export const getTextSelection = () => {
  const editor = window.activeTextEditor
  const selection = editor?.selection
  const text = editor?.document.getText(selection)
  return text || ""
}

export const getLanguage = (): LanguageType => {
  const editor = window.activeTextEditor
  const languageId = editor?.document.languageId
  const language =
    supportedLanguages[languageId as keyof typeof supportedLanguages]
  return {
    language,
    languageId
  }
}

export const getTheme = () => {
  const currentTheme = window.activeColorTheme
  if (currentTheme.kind === ColorThemeKind.Light) {
    return Theme.Light
  } else if (currentTheme.kind === ColorThemeKind.Dark) {
    return Theme.Dark
  } else {
    return Theme.Contrast
  }
}

export const getTerminal = async (): Promise<Terminal | undefined> => {
  const pointerTerminal = window.terminals.find((t) => t.name === POINTER)
  if (pointerTerminal) return pointerTerminal
  const terminal = window.createTerminal({ name: POINTER })
  terminal.show()
  return terminal
}

export function getNonce() {
  let text = ""
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}

export function readGitSubmodulesFile(): string[] | undefined {
  try {
    const folders = workspace.workspaceFolders
    if (!folders || folders.length === 0) return undefined
    const rootPath = folders[0].uri.fsPath
    if (!rootPath) return undefined
    const gitSubmodulesFilePath = path.join(rootPath, ".gitmodules")
    if (!fs.existsSync(gitSubmodulesFilePath)) return undefined
    const submodulesFileContent = fs
      .readFileSync(gitSubmodulesFilePath)
      .toString()
    const submodulePaths: string[] = []
    submodulesFileContent.split("\n").forEach((line: string) => {
      if (line.startsWith("\tpath = ")) {
        submodulePaths.push(line.slice(8))
      }
    })
    return submodulePaths
  } catch {
    return undefined
  }
}

export async function getAllFilePaths(dirPath: string): Promise<string[]> {
  if (!dirPath) return []

  const rootPath = workspace.workspaceFolders?.[0]?.uri.fsPath || ""
  const config = workspace.getConfiguration("pointer")
  const submodules = readGitSubmodulesFile()

  const ig = ignore()
  const embeddingIgnoredGlobs = config.get<string[]>(
    "embeddingIgnoredGlobs",
    []
  )
  ig.add([...embeddingIgnoredGlobs, ".git", ".gitignore"])

  const gitIgnoreFilePath = path.join(rootPath, ".gitignore")
  if (fs.existsSync(gitIgnoreFilePath)) {
    ig.add(fs.readFileSync(gitIgnoreFilePath).toString())
  }

  const filePaths: string[] = []
  const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true })

  for (const dirent of dirents) {
    const fullPath = path.join(dirPath, dirent.name)
    const relativePath = "/" + path.relative(rootPath, fullPath)

    if (submodules?.some((submodule) => relativePath.includes(submodule))) {
      continue
    }

    if (ig.ignores(relativePath.slice(1))) {
      continue
    }

    if (dirent.isDirectory()) {
      filePaths.push(...(await getAllFilePaths(fullPath)))
    } else if (dirent.isFile() && isIndexablePath(fullPath)) {
      filePaths.push(relativePath)
    }
  }

  return filePaths
}
