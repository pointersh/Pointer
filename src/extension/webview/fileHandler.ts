import * as fs from "fs"
import ignore from "ignore"
import * as path from "path"
import * as vscode from "vscode"

import { EVENT_NAME } from "../../common/constants"
import { FileLocation } from "../../common/messaging/protocol"
import { workspacePathCandidates } from "../chat/contextFiles"
import { decodeSymbolRef } from "../chat/symbolRef"
import { ExtensionBridge } from "../messaging/bridge"

export class FileHandler {
  constructor(private readonly _bridge: ExtensionBridge) {
    this.registerHandlers()
  }

  private getIgnoreHandler(): ReturnType<typeof ignore> {
    const ig = ignore()
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

    if (rootPath) {
      try {
        ig.add(fs.readFileSync(path.join(rootPath, ".gitignore")).toString())
      } catch {
        // no .gitignore
      }
    }

    ig.add([".git", ".gitignore", "node_modules", "*.log", "dist", "build"])

    return ig
  }

  private async getClosestFilePathMatch(
    targetPath: string
  ): Promise<string | undefined> {
    if (!vscode.workspace.workspaceFolders) {
      return undefined
    }

    // Deadline and cap: a missing-link click must not stall the extension host in a big repo.
    const cancel = new vscode.CancellationTokenSource()
    const timer = setTimeout(() => cancel.cancel(), 3_000)
    let files: vscode.Uri[]
    try {
      files = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git}/**", 20_000, cancel.token)
    } finally {
      clearTimeout(timer)
      cancel.dispose()
    }
    const ig = this.getIgnoreHandler()

    const filePaths = files
      .map((file) => vscode.workspace.asRelativePath(file))
      .filter((relativePath) => !ig.ignores(relativePath))

    if (filePaths.length === 0) {
      return undefined
    }

    const targetParts = path
      .basename(targetPath)
      .replace(/\.[^/.]+$/, "")
      .split(/[^a-zA-Z0-9]+/)
    const matchingPath = filePaths.find((p) => {
      const fileName = path.basename(p).replace(/\.[^/.]+$/, "")
      return targetParts.every((part) =>
        fileName.toLowerCase().includes(part.toLowerCase())
      )
    })

    if (matchingPath) {
      return matchingPath
    }

    const dirMatch = filePaths.find((p) => {
      const normalizedTarget = targetPath.toLowerCase()
      const normalizedPath = p.toLowerCase()
      return (
        normalizedPath.includes(normalizedTarget) ||
        normalizedTarget.includes(normalizedPath)
      )
    })

    return dirMatch
  }

  public async handleOpenFile(target: string | FileLocation) {
    const symbol = typeof target === "string" ? decodeSymbolRef(target) : undefined
    const location: FileLocation = symbol
      ? { path: symbol.path, startLine: symbol.line }
      : typeof target === "string"
        ? { path: target }
        : target
    const filePath = location.path
    if (filePath && vscode.workspace.workspaceFolders) {
      const candidates = workspacePathCandidates(
        filePath,
        vscode.workspace.workspaceFolders.map((folder) => ({
          name: folder.name,
          fsPath: folder.uri.fsPath
        }))
      ).map((candidate) => path.normalize(candidate))
      const fullPath =
        candidates.find((candidate) => fs.existsSync(candidate)) ??
        path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath)
      if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fullPath))) return
      try {
        const doc = await vscode.workspace.openTextDocument(fullPath)
        const editor = await vscode.window.showTextDocument(doc)
        if (location.startLine !== undefined) {
          const start = new vscode.Position(location.startLine, 0)
          const endLine = Math.min(
            location.endLine ?? location.startLine,
            Math.max(0, doc.lineCount - 1)
          )
          const end = doc.lineAt(endLine).range.end
          editor.selection = new vscode.Selection(start, end)
          editor.revealRange(
            new vscode.Range(start, end),
            vscode.TextEditorRevealType.InCenter
          )
        }
      } catch (error) {
        console.error(`Error opening file ${filePath}:`, error)

        const similarFile = await this.getClosestFilePathMatch(filePath)
        if (similarFile) {
          // asRelativePath carries the folder name in multi-root workspaces, so resolve it like the primary path.
          const similarFullPath =
            workspacePathCandidates(
              similarFile,
              vscode.workspace.workspaceFolders.map((folder) => ({
                name: folder.name,
                fsPath: folder.uri.fsPath
              }))
            )
              .map((candidate) => path.normalize(candidate))
              .find((candidate) => fs.existsSync(candidate)) ?? similarFile
          try {
            const doc = await vscode.workspace.openTextDocument(similarFullPath)
            await vscode.window.showTextDocument(doc)
            vscode.window.showInformationMessage(
              `File "${filePath}" not found. Opened similar file: "${similarFile}"`
            )
          } catch (innerError) {
            console.error(
              `Error opening similar file ${similarFile}:`,
              innerError
            )
            vscode.window.showWarningMessage(`Could not open similar file "${similarFile}".`)
          }
        } else {
          vscode.window.showInformationMessage(
            `File "${filePath}" not found and no similar files found.`
          )
        }
      }
    } else {
      vscode.window.showInformationMessage("No workspace open.")
    }
  }

  public registerHandlers() {
    this._bridge.handle(EVENT_NAME.pointerOpenFile, (filePath) =>
      this.handleOpenFile(filePath)
    )
  }
}
