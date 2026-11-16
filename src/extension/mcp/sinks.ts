import { Disposable, workspace } from "vscode"

import { editorEdits, editorKnowledge, terminalCommands } from "../chat/toolSinks"
import { WorkspaceView } from "../tools/view"
import { ToolExtras } from "../tools/workspace"

const openText = async (file: string) => workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === file)?.getText()

export const editorExtras = (root: string): { view: WorkspaceView; extras: ToolExtras; watcher: Disposable } => {
  const view = new WorkspaceView(root, [], openText)
  const watcher = workspace.createFileSystemWatcher("**/*", false, true, false)
  watcher.onDidCreate(() => view.forgetFiles())
  watcher.onDidDelete(() => view.forgetFiles())
  return {
    view,
    watcher,
    extras: { edits: editorEdits(view), editor: editorKnowledge(view), commands: terminalCommands(root) }
  }
}
