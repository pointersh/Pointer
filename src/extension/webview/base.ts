import * as vscode from "vscode"

import {
  EVENT_NAME,
  POINTER_COMMAND_NAME,
  WORKSPACE_STORAGE_KEY
} from "../../common/constants"
import { logger } from "../../common/logger"
import {
  ContextValue,
  NewDocumentRequest
} from "../../common/messaging/protocol"
import { AnyContextItem } from "../../common/types"
import { Agent } from "../agent"
import { searchSymbols } from "../chat/symbols"
import { ExtensionBridge } from "../messaging/bridge"
import { SessionManager } from "../session-manager"
import { getLanguage, getTerminal, getTextSelection, getTheme } from "../utils"

import { resolveLanguageId, stripShellPrompts } from "./code-actions"
import { FileHandler } from "./file-handler"
import { FileTreeProvider } from "./file-tree"

const storageKeyFor = (scope: string, key: string) => `${scope}-${key}`

export class BaseProvider {
  private _fileTreeProvider: FileTreeProvider
  private _sessionManager: SessionManager | undefined
  private _disposables: vscode.Disposable[] = []
  public bridge: ExtensionBridge | undefined
  public agent: Agent | undefined
  public createAgent?: (bridge: ExtensionBridge) => Agent
  public context: vscode.ExtensionContext
  public webView?: vscode.Webview

  private _sidebarReadyHandler?: () => void

  public registerSidebarReadyHandler(handler: () => void) {
    this._sidebarReadyHandler = handler
  }

  constructor(
    context: vscode.ExtensionContext,
    sessionManager?: SessionManager
  ) {
    this.context = context
    this._fileTreeProvider = new FileTreeProvider()
    this._sessionManager = sessionManager
  }

  public registerWebView(webView: vscode.Webview) {
    this.dispose()
    this.webView = webView
    this.bridge = new ExtensionBridge(webView)
    new FileHandler(this.bridge)
    this.agent = this.createAgent?.(this.bridge)
    this.registerHandlers(this.bridge)
    this.registerEditorListeners(this.bridge)
    logger.info("Webview registered successfully")
  }

  public dispose() {
    this.agent?.abort()
    this.agent = undefined
    this.bridge?.dispose()
    this.bridge = undefined
    this._disposables.forEach((disposable) => disposable.dispose())
    this._disposables = []
  }

  private registerHandlers(bridge: ExtensionBridge) {
    bridge.handleAll({
      [EVENT_NAME.pointerAcceptSolution]: (code) =>
        void vscode.commands.executeCommand(POINTER_COMMAND_NAME.applyCode, code),
      [EVENT_NAME.pointerChatMessage]: ({ messages, mentions }) =>
        void this.agent?.completion(messages, mentions),
      [EVENT_NAME.pointerFileListRequest]: () =>
        this._fileTreeProvider.getAllFiles(),
      [EVENT_NAME.pointerGetConfigValue]: ({ key }) => ({
        key,
        value: vscode.workspace.getConfiguration("pointer").get(key)
      }),
      [EVENT_NAME.pointerGetContextItems]: () =>
        this.broadcastContextItems(this.readContextItems()),
      [EVENT_NAME.pointerGlobalContext]: ({ key }) =>
        this.readGlobalContext(key),
      [EVENT_NAME.pointerGetWorkspaceContext]: ({ key }) =>
        this.readWorkspaceContext(key),
      [EVENT_NAME.pointerSessionContext]: ({ key }) =>
        this.readSessionContext(key),
      [EVENT_NAME.pointerSetGlobalContext]: (value) =>
        this.writeGlobalContext(value),
      [EVENT_NAME.pointerSetWorkspaceContext]: (value) =>
        this.writeWorkspaceContext(value),
      [EVENT_NAME.pointerSetSessionContext]: (value) =>
        this.writeSessionContext(value),
      [EVENT_NAME.pointerNewConversation]: () => this.newConversation(),
      [EVENT_NAME.pointerNewDocument]: (request) =>
        this.createNewUntitledDocument(request),
      [EVENT_NAME.pointerNotification]: (message) =>
        void vscode.window.showInformationMessage(message),
      [EVENT_NAME.pointerRemoveContextItem]: (id) => this.removeContextItem(id),
      [EVENT_NAME.pointerRunInTerminal]: (command) =>
        this.sendToTerminal(command),
      [EVENT_NAME.pointerInsertAtCursor]: (code) => this.insertAtCursor(code),
      [EVENT_NAME.pointerSendLanguage]: () => getLanguage(),
      [EVENT_NAME.pointerSendTheme]: () => getTheme(),
      [EVENT_NAME.pointerSetConfigValue]: ({ key, value }) =>
        void vscode.workspace
          .getConfiguration("pointer")
          .update(key, value, vscode.ConfigurationTarget.Global),
      [EVENT_NAME.pointerSidebarReady]: () => this._sidebarReadyHandler?.(),
      [EVENT_NAME.pointerStopGeneration]: () => this.destroyStream(),
      [EVENT_NAME.pointerToolApproval]: ({ id, run, always }) => this.agent?.answerToolApproval(id, run, always),
      [EVENT_NAME.pointerToolStop]: ({ id }) => this.agent?.stopToolStep(id),
      [EVENT_NAME.pointerSteer]: ({ id, text }) => this.agent?.steer(id, text),
      [EVENT_NAME.pointerOpenChange]: ({ id, path }) => void this.agent?.openChange(id, path),
      [EVENT_NAME.pointerOpenAgentSettings]: () =>
        void vscode.commands.executeCommand("workbench.action.openSettings", "pointer.chatTools"),
      [EVENT_NAME.pointerUndoChanges]: async ({ id, paths }) =>
        (await this.agent?.undoChanges(id, paths)) ?? { error: "The chat is not ready." },
      [EVENT_NAME.pointerSymbolSearch]: ({ query }) => searchSymbols(query),
      [EVENT_NAME.pointerTextSelection]: () => getTextSelection()
    })
  }

  private registerEditorListeners(bridge: ExtensionBridge) {
    this._disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        bridge.emit(EVENT_NAME.pointerSendTheme, getTheme())
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        bridge.emit(
          EVENT_NAME.pointerTextSelection,
          event.textEditor.document.getText(event.selections[0])
        )
      })
    )
  }

  public destroyStream = () => {
    this.agent?.abort()
    this.bridge?.emit(EVENT_NAME.pointerStopGeneration)
  }

  private readContextItems = () =>
    this.context?.workspaceState.get<AnyContextItem[]>(
      WORKSPACE_STORAGE_KEY.contextItems
    ) || []

  addContextItem = (item: AnyContextItem) => {
    const items = this.readContextItems()
    const index = items.findIndex((existing) => existing.id === item.id)
    const updated = [...items]
    if (index > -1) updated[index] = item
    else updated.push(item)
    this.saveContextItems(updated)
  }

  removeContextItem = (id: string) => {
    this.saveContextItems(this.readContextItems().filter((i) => i.id !== id))
  }

  private saveContextItems = (items: AnyContextItem[]) => {
    this.context?.workspaceState.update(
      WORKSPACE_STORAGE_KEY.contextItems,
      items
    )
    this.broadcastContextItems(items)
  }

  private broadcastContextItems = (items: AnyContextItem[]) => {
    this.bridge?.emit(EVENT_NAME.pointerUpdateContextItems, items)
  }

  private readGlobalContext = (key: string): ContextValue => ({
    key,
    value: this.context?.globalState.get(
      storageKeyFor(EVENT_NAME.pointerGlobalContext, key)
    )
  })

  private writeGlobalContext = ({ key, value }: ContextValue) => {
    this.context?.globalState.update(
      storageKeyFor(EVENT_NAME.pointerGlobalContext, key),
      value
    )
    this.bridge?.emit(EVENT_NAME.pointerGlobalContext, { key, value })
  }

  private readWorkspaceContext = (key: string): ContextValue => ({
    key,
    value: this.context?.workspaceState.get(
      storageKeyFor(EVENT_NAME.pointerGetWorkspaceContext, key)
    )
  })

  private writeWorkspaceContext = ({ key, value }: ContextValue) => {
    this.context?.workspaceState.update(
      storageKeyFor(EVENT_NAME.pointerGetWorkspaceContext, key),
      value
    )
    this.bridge?.emit(EVENT_NAME.pointerGetWorkspaceContext, { key, value })
  }

  private readSessionContext = (key: string): ContextValue => ({
    key,
    value: this._sessionManager?.get(key)
  })

  private writeSessionContext = ({ key, value }: ContextValue) => {
    this._sessionManager?.set(key, value)
    this.bridge?.emit(EVENT_NAME.pointerSessionContext, { key, value })
  }

  public newConversation = () => {
    this.agent?.resetConversation()
    this.bridge?.emit(EVENT_NAME.pointerNewConversation)
    this.agent?.discardReply()
  }

  private createNewUntitledDocument = async ({
    content,
    language
  }: NewDocumentRequest) => {
    const document = await vscode.workspace.openTextDocument({
      content,
      language: await resolveLanguageId(language, getLanguage().languageId)
    })
    await vscode.window.showTextDocument(document)
  }

  private insertAtCursor = async (code: string) => {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      void vscode.window.showWarningMessage(
        "Open a file to insert the code into."
      )
      return
    }
    await vscode.window.showTextDocument(editor.document, editor.viewColumn)
    await editor.edit((builder) => {
      for (const selection of editor.selections) builder.replace(selection, code)
    })
  }

  private sendToTerminal = async (command: string) => {
    const terminal = await getTerminal()
    if (!terminal) return
    terminal.show()
    terminal.sendText(stripShellPrompts(command), false)
  }
}
