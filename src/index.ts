import * as path from "path"
import { v4 as uuidv4 } from "uuid"
import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from "vscode"
import * as vscode from "vscode"

import {
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_NAME,
  POINTER_COMMAND_NAME,
  WEBUI_TABS
} from "./common/constants"
import { logger } from "./common/logger"
import { ContextItem, SelectionContextItem } from "./common/types"
import { setContext } from "./extension/context"
import { InlineEditCodeActionProvider } from "./extension/edit/code-actions"
import { InlineEditCodeLensProvider } from "./extension/edit/code-lens"
import {
  ChatEditMode,
  FileEditProposal,
  InlineEditArgs,
  InlineEditService
} from "./extension/edit/service"
import { WorkspaceIndex } from "./extension/embeddings"
import { GenerationTracker } from "./extension/generations"
import { setUpProvidersOnFirstRun } from "./extension/providers/setup"
import { ProviderStore } from "./extension/providers/store"
import { SessionManager } from "./extension/session-manager"
import { PointerStatusBar } from "./extension/status-bar"
import { terminalHistory } from "./extension/terminal"
import { SidebarProvider } from "./extension/webview/sidebar"

const TABS = [
  [POINTER_COMMAND_NAME.manageProviders, EXTENSION_CONTEXT_NAME.pointerManageProviders, WEBUI_TABS.providers],
  [POINTER_COMMAND_NAME.embeddings, EXTENSION_CONTEXT_NAME.pointerEmbeddingsTab, WEBUI_TABS.embeddings],
  [POINTER_COMMAND_NAME.conversationHistory, EXTENSION_CONTEXT_NAME.pointerConversationHistory, WEBUI_TABS.history]
] as const

export async function activate(context: ExtensionContext) {
  setContext(context)
  const generations = new GenerationTracker()
  const statusBar = new PointerStatusBar(
    window.createStatusBarItem(StatusBarAlignment.Right),
    context,
    generations
  )

  const providerSetup = setUpProvidersOnFirstRun(context, new ProviderStore(context))

  const workspaceIndex = await WorkspaceIndex.open(context)
  if (workspaceIndex) context.subscriptions.push(workspaceIndex)

  const sidebarProvider = new SidebarProvider(
    generations,
    context,
    workspaceIndex,
    new SessionManager()
  )
  const inlineEdit = new InlineEditService(context, generations)

  const setTab = (contextName: string, tab: string) => {
    void commands.executeCommand("setContext", contextName, true)
    sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, tab)
  }

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
    commands.registerCommand(POINTER_COMMAND_NAME.chatFileEdit, (proposal: FileEditProposal, mode?: ChatEditMode) =>
      inlineEdit.chatEdit(proposal, mode)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.chatFileCreate, (file: string, content: string, mode?: ChatEditMode) =>
      inlineEdit.chatCreate(file, content, mode)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.stopGeneration, () => generations.stopAll()),
    ...TABS.map(([command, contextName, tab]) => commands.registerCommand(command, () => setTab(contextName, tab))),
    commands.registerCommand(POINTER_COMMAND_NAME.hideBackButton, () => {
      for (const [, contextName] of TABS) void commands.executeCommand("setContext", contextName, false)
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.openChat, () => {
      void commands.executeCommand(POINTER_COMMAND_NAME.hideBackButton)
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.chat)
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.settings, () =>
      commands.executeCommand("workbench.action.openSettings", EXTENSION_NAME)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.newConversation, () => {
      sidebarProvider.newConversation()
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.chat)
    }),
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
        id: uuidv4(),
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
  void providerSetup.then(() => statusBar.refresh())
}

export function deactivate() {}
