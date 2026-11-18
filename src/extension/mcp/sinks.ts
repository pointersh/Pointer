import { Disposable, workspace } from "vscode"

import { editorEdits, editorKnowledge, terminalCommands } from "../chat/toolSinks"
import { WorkspaceView } from "../tools/view"
import { ToolExtras } from "../tools/workspace"

// Never shown to the model, even when committed: they hold credentials, not code.
const SECRET_FILES = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".htpasswd",
  "id_dsa*",
  "*.p8",
  "*.jks",
  "*.keystore",
  "*.ppk",
  "*.kdbx",
  ".aws/credentials",
  ".docker/config.json"
]

const openText = async (file: string) => workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === file)?.getText()

export const editorExtras = (root: string): { view: WorkspaceView; extras: ToolExtras; watcher: Disposable } => {
  const view = new WorkspaceView(root, [], openText, SECRET_FILES)
  const watcher = workspace.createFileSystemWatcher("**/*", false, true, false)
  watcher.onDidCreate(() => view.forgetFiles())
  watcher.onDidDelete(() => view.forgetFiles())
  return {
    view,
    watcher,
    extras: { edits: editorEdits(view), editor: editorKnowledge(view), commands: terminalCommands(root) }
  }
}
