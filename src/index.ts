import * as path from "path"
import { commands, ExtensionContext, languages, StatusBarAlignment, window, workspace } from "vscode"
import * as vscode from "vscode"

import { EXTENSION_CONTEXT_NAME, EXTENSION_NAME, POINTER_COMMAND_NAME } from "./common/constants"
import { logger } from "./common/logger"
import { ContextItem, SelectionContextItem } from "./common/types"
import { InlineEditCodeActionProvider } from "./extension/edit/codeActions"
import { InlineEditCodeLensProvider } from "./extension/edit/codeLens"
import { FileEditProposal, InlineEditArgs, InlineEditService } from "./extension/edit/service"
import { GenerationTracker } from "./extension/generations"
import { setTextModel } from "./extension/model"
import { SessionManager } from "./extension/sessionManager"
import { PointerStatusBar } from "./extension/statusBar"
import { terminalHistory } from "./extension/terminal"
import { TrueForgeAgent } from "./extension/trueforge/agent"
import { trueforgeTextModel } from "./extension/trueforge/inline"
import { describeError, registerAgent } from "./extension/trueforge/setup"
import { SidebarProvider } from "./extension/webview/sidebar"

export function activate(context: ExtensionContext) {
  const generations = new GenerationTracker()
  const statusBar = new PointerStatusBar(window.createStatusBarItem(StatusBarAlignment.Right), context, generations)
  const sidebarProvider = new SidebarProvider(context, new SessionManager())
  const inlineEdit = new InlineEditService(context, generations)
  discardPending = () => inlineEdit.discard()
  sidebarProvider.createAgent = (bridge) => new TrueForgeAgent(bridge, generations)
  setTextModel(trueforgeTextModel())
  void registerAgent(context).catch((error) => {
    logger.error(`TrueForge setup failed: ${describeError(error)}`)
    void window.showWarningMessage(describeError(error))
  })
  const addContextItem = (item: ContextItem | SelectionContextItem) => sidebarProvider.addContextItem(item)

  context.subscriptions.push(
    statusBar,
    inlineEdit,
    terminalHistory,
    generations.onDidChange(({ stoppable }) => {
      void commands.executeCommand("setContext", EXTENSION_CONTEXT_NAME.pointerGeneratingText, stoppable)
    }),
    languages.registerCodeActionsProvider({ scheme: "file" }, new InlineEditCodeActionProvider(), {
      providedCodeActionKinds: InlineEditCodeActionProvider.providedCodeActionKinds
    }),
    languages.registerCodeLensProvider({ pattern: "**" }, new InlineEditCodeLensProvider(inlineEdit)),
    commands.registerCommand(POINTER_COMMAND_NAME.showLogs, () => logger.show()),
    commands.registerCommand(POINTER_COMMAND_NAME.edit, (args?: InlineEditArgs) => inlineEdit.run(args)),
    commands.registerCommand(POINTER_COMMAND_NAME.acceptEdit, (hunk?: number) =>
      inlineEdit.accept(typeof hunk === "number" ? hunk : undefined)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.rejectEdit, (hunk?: number) =>
      inlineEdit.reject(typeof hunk === "number" ? hunk : undefined)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.applyCode, (code: string) => inlineEdit.propose(String(code ?? ""))),
    commands.registerCommand(POINTER_COMMAND_NAME.chatFileEdit, (proposal: FileEditProposal) =>
      inlineEdit.chatEdit(proposal)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.chatFileCreate, (file: string, content: string, ticket?: string) =>
      inlineEdit.chatCreate(file, content, ticket)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.saveAgentEdits, () => inlineEdit.saveAgentEdits()),
    commands.registerCommand(POINTER_COMMAND_NAME.stopGeneration, () => generations.stopAll()),
    commands.registerCommand(POINTER_COMMAND_NAME.settings, () =>
      commands.executeCommand("workbench.action.openSettings", EXTENSION_NAME)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.newConversation, () => sidebarProvider.newConversation()),
    commands.registerCommand(POINTER_COMMAND_NAME.addFileToContext, async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const active = window.activeTextEditor?.document.uri
      const uris = selected?.length ? selected : clicked ? [clicked] : active ? [active] : []
      let added = 0
      for (const uri of uris) {
        if (uri.scheme !== "file") continue
        const stat = await workspace.fs.stat(uri).then((s) => s, () => undefined)
        if (stat?.type !== vscode.FileType.File) continue
        const filePath = workspace.asRelativePath(uri)
        addContextItem({ id: filePath, category: "files", name: path.basename(uri.fsPath), path: filePath })
        added++
      }
      if (!added) window.showInformationMessage("No file to add to the chat context.")
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.addSelectionToContext, () => {
      const editor = window.activeTextEditor
      if (!editor || editor.selection.isEmpty) {
        window.showInformationMessage("No text selected to add to context.")
        return
      }
      const { selection, document } = editor
      const filePath = workspace.asRelativePath(document.uri.fsPath)
      addContextItem({
        id: crypto.randomUUID(),
        category: "selection",
        name: `Selection from ${path.basename(filePath)} (L${selection.start.line + 1}-L${selection.end.line + 1})`,
        path: filePath,
        content: document.getText(selection),
        selectionRange: {
          startLine: selection.start.line,
          startCharacter: selection.start.character,
          endLine: selection.end.line,
          endCharacter: selection.end.character
        }
      })
    }),
    window.registerWebviewViewProvider("pointer.sidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pointer")) statusBar.refresh()
    })
  )

  statusBar.refresh()
}

let discardPending: (() => Promise<void>) | undefined

export function deactivate() {
  return discardPending?.()
}
