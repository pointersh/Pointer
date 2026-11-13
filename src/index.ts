import * as os from "os"
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
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_NAME,
  GLOBAL_STORAGE_KEY,
  POINTER_COMMAND_NAME,
  WEBUI_TABS
} from "./common/constants"
import { messageOf } from "./common/errors"
import { formatMs, logger } from "./common/logger"
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
import { providerUrl } from "./extension/providers/errors"
import { PointerProvider } from "./extension/providers/manager"
import { setUpProvidersOnFirstRun } from "./extension/providers/setup"
import { ProviderStore } from "./extension/providers/store"
import { SessionManager } from "./extension/session-manager"
import { PointerStatusBar } from "./extension/status-bar"
import { TemplateProvider } from "./extension/templates/provider"
import { terminalHistory } from "./extension/terminal"
import { runDescribedCommand } from "./extension/terminal/command"
import { fixTerminalError } from "./extension/terminal/fix"
import { FullScreenProvider } from "./extension/webview/panel"
import { SidebarProvider } from "./extension/webview/sidebar"

const TEMPLATE_COMMANDS: Record<string, string> = {
  [POINTER_COMMAND_NAME.explain]: "explain"
}

const EDIT_COMMANDS: Record<string, string> = {
  [POINTER_COMMAND_NAME.refactor]:
    "Refactor this code to improve readability and efficiency without changing its behaviour.",
  [POINTER_COMMAND_NAME.addTypes]:
    "Add precise type annotations, keeping the logic unchanged.",
  [POINTER_COMMAND_NAME.generateDocs]:
    "Add documentation comments in the standard format for this language (JSDoc, docstrings, etc.). Keep the code itself unchanged."
}

async function showStatusBarMenu() {
  const picked = await window.showQuickPick(
    [
      {
        label: "$(comment-discussion) Open chat",
        action: "chat"
      },
      {
        label: "$(robot) Manage providers",
        action: "providers"
      },
      {
        label: "$(gear) Settings",
        action: "settings"
      },
      {
        label: "$(output) Show logs",
        description: "Requests, timings and errors in the Output panel",
        action: "logs"
      }
    ],
    { title: "Pointer", placeHolder: "What would you like to do?" }
  )

  switch (picked?.action) {
    case "chat":
      await commands.executeCommand(POINTER_COMMAND_NAME.focusSidebar)
      await commands.executeCommand(POINTER_COMMAND_NAME.openChat)
      break
    case "providers":
      await commands.executeCommand(POINTER_COMMAND_NAME.focusSidebar)
      await commands.executeCommand(POINTER_COMMAND_NAME.manageProviders)
      break
    case "settings":
      await commands.executeCommand(POINTER_COMMAND_NAME.settings)
      break
    case "logs":
      logger.show()
      break
  }
}

const describeProvider = (provider: PointerProvider | undefined) =>
  provider
    ? `${provider.modelName} via ${provider.label} at ${providerUrl(provider) || "(no address)"}`
    : "none"

const logStartup = (context: ExtensionContext, startedAt: number) => {
  const version = context.extension.packageJSON.version
  const read = (key: string) => context.globalState.get<PointerProvider>(key)
  logger.info(
    `Pointer ${version} ready in ${formatMs(Date.now() - startedAt)} · ` +
      `VS Code ${vscode.version} · ${os.platform()} ${os.release()}`
  )
  logger.info(`  chat:        ${describeProvider(read(ACTIVE_CHAT_PROVIDER_STORAGE_KEY))}`)
  logger.info(`  embeddings:  ${describeProvider(read(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY))}`)
}

export async function activate(context: ExtensionContext) {
  setContext(context)
  const generations = new GenerationTracker()
  context.subscriptions.push(
    generations.onDidChange(({ stoppable }) => {
      void commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerGeneratingText,
        stoppable
      )
    })
  )
  const statusBar = new PointerStatusBar(
    window.createStatusBarItem(StatusBarAlignment.Right),
    context,
    generations
  )

  const startedAt = Date.now()
  const templateDir = path.join(os.homedir(), ".pointer/templates") as string
  const templateProvider = new TemplateProvider(templateDir)
  const sessionManager = new SessionManager()


  const providerSetup = setUpProvidersOnFirstRun(
    context,
    new ProviderStore(context)
  )


  const fullScreenProvider = new FullScreenProvider(
    context,
    templateDir,
    generations
  )

  const workspaceIndex = await WorkspaceIndex.open(context)
  if (workspaceIndex) context.subscriptions.push(workspaceIndex)

  const sidebarProvider = new SidebarProvider(
    generations,
    context,
    templateDir,
    workspaceIndex,
    sessionManager
  )

  const inlineEdit = new InlineEditService(context, generations)

  templateProvider.init()

  const runTemplate = async (template: string) => {
    await commands.executeCommand(POINTER_COMMAND_NAME.focusSidebar)
    await sidebarProvider.waitForSidebarReady()
    sidebarProvider.streamTemplateCompletion(template)
  }

  const requireChat = async () => {
    if (!sidebarProvider.chat) {
      await commands.executeCommand(POINTER_COMMAND_NAME.focusSidebar)
      await sidebarProvider.waitForSidebarReady()
    }
    return sidebarProvider.chat
  }

  const setEnabled = (enabled: boolean) =>
    workspace
      .getConfiguration("pointer")
      .update("enabled", enabled, vscode.ConfigurationTarget.Global)

  context.subscriptions.push(
    statusBar,
    inlineEdit,
    terminalHistory,
    commands.registerCommand(POINTER_COMMAND_NAME.showLogs, () => logger.show()),
    commands.registerCommand(POINTER_COMMAND_NAME.terminalCommand, async () => {
      const chat = await requireChat()
      if (chat) await runDescribedCommand(chat, terminalHistory)
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.fixTerminalError, async () => {
      const chat = await requireChat()
      if (chat) await fixTerminalError(chat, terminalHistory)
    }),
    languages.registerCodeActionsProvider(
      { scheme: "file" },
      new InlineEditCodeActionProvider(),
      {
        providedCodeActionKinds:
          InlineEditCodeActionProvider.providedCodeActionKinds
      }
    ),
    languages.registerCodeLensProvider(
      { pattern: "**" },
      new InlineEditCodeLensProvider(inlineEdit)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.edit, (args?: InlineEditArgs) =>
      inlineEdit.run(args)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.acceptEdit, (hunk?: number) =>
      inlineEdit.accept(typeof hunk === "number" ? hunk : undefined)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.rejectEdit, (hunk?: number) =>
      inlineEdit.reject(typeof hunk === "number" ? hunk : undefined)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.applyCode, (code: string) =>
      inlineEdit.propose(String(code ?? ""))
    ),
    commands.registerCommand(
      POINTER_COMMAND_NAME.chatFileEdit,
      (proposal: FileEditProposal, mode?: ChatEditMode) => inlineEdit.chatEdit(proposal, mode)
    ),
    commands.registerCommand(
      POINTER_COMMAND_NAME.chatFileCreate,
      (file: string, content: string, mode?: ChatEditMode) => inlineEdit.chatCreate(file, content, mode)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.addTests, () =>
      inlineEdit.writeTests()
    ),
    ...Object.entries(TEMPLATE_COMMANDS).map(([command, template]) =>
      commands.registerCommand(command, () => runTemplate(template))
    ),
    ...Object.entries(EDIT_COMMANDS).map(([command, instruction]) =>
      commands.registerCommand(command, () =>
        inlineEdit.run({ instruction, requireSelection: true })
      )
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.enable, () => setEnabled(true)),
    commands.registerCommand(POINTER_COMMAND_NAME.disable, () =>
      setEnabled(false)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.statusBarMenu, () =>
      showStatusBarMenu()
    ),
    commands.registerCommand(
      POINTER_COMMAND_NAME.templateCompletion,
      (template: string) => runTemplate(template)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.stopGeneration, () =>
      generations.stopAll()
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.manageProviders, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerManageProviders,
        true
      )
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.providers)
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.embeddings, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerEmbeddingsTab,
        true
      )
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.embeddings)
    }),
    commands.registerCommand(
      POINTER_COMMAND_NAME.conversationHistory,
      async () => {
        commands.executeCommand(
          "setContext",
          EXTENSION_CONTEXT_NAME.pointerConversationHistory,
          true
        )
        sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.history)
      }
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.review, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerReviewTab,
        true
      )
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.review)
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.templates, () =>
      sidebarProvider.editDefaultTemplates()
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.manageTemplates, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerManageTemplates,
        true
      )
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.settings)
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.hideBackButton, () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerManageTemplates,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerConversationHistory,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerManageProviders,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.pointerReviewTab,
        false
      )
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.openChat, () => {
      commands.executeCommand(POINTER_COMMAND_NAME.hideBackButton)
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.chat)
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.settings, () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        EXTENSION_NAME
      )
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.newConversation, () => {
      sidebarProvider.newConversation()
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.chat)
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.exportConversation, () =>
      sidebarProvider.bridge?.emit(EVENT_NAME.pointerExportConversation)
    ),
    commands.registerCommand(POINTER_COMMAND_NAME.forgetAlwaysRunCommands, async () => {
      const key = `${EVENT_NAME.pointerGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunCommands}`
      const kept = context.globalState.get<string[]>(key) ?? []
      await context.globalState.update(key, undefined)
      window.showInformationMessage(
        kept.length
          ? `Pointer will ask again before running ${kept.length === 1 ? "the command" : `the ${kept.length} commands`} you chose Always run for.`
          : "No commands were set to always run."
      )
    }),
    commands.registerCommand(POINTER_COMMAND_NAME.openPanelChat, () => {
      commands.executeCommand("workbench.action.closeSidebar")
      fullScreenProvider.createOrShowPanel()
    }),
    commands.registerCommand(
      POINTER_COMMAND_NAME.addFileToContext,
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const uris = selected?.length
          ? selected
          : clicked
            ? [clicked]
            : window.activeTextEditor
              ? [window.activeTextEditor.document.uri]
              : []

        let added = 0
        for (const uri of uris) {
          if (uri.scheme !== "file") continue
          const stat = await workspace.fs.stat(uri).then(
            (s) => s,
            () => undefined
          )
          if (!stat || stat.type !== vscode.FileType.File) continue
          const filePath = workspace.asRelativePath(uri)
          const fileContextItem: ContextItem = {
            id: filePath,
            category: "files",
            name: path.basename(uri.fsPath),
            path: filePath
          }
          sidebarProvider.addContextItem(fileContextItem)
          added++
        }

        if (added === 0) {
          window.showInformationMessage("No file to add to the chat context.")
        } else if (uris.length > 1) {
          window.setStatusBarMessage(
            `Pointer: added ${added} files to the chat context`,
            4000
          )
        }
      }
    ),
    commands.registerCommand(
      POINTER_COMMAND_NAME.addSelectionToContext,
      async () => {
        const editor = window.activeTextEditor
        if (editor && !editor.selection.isEmpty) {
          const selection = editor.selection
          const selectedText = editor.document.getText(selection)
          const filePath = workspace.asRelativePath(editor.document.uri.fsPath)
          const selectionContextItem: SelectionContextItem = {
            id: uuidv4(),
            category: "selection",
            name: `Selection from ${path.basename(filePath)} (L${
              selection.start.line + 1
            }-L${selection.end.line + 1})`,
            path: filePath,
            content: selectedText,
            selectionRange: {
              startLine: selection.start.line,
              startCharacter: selection.start.character,
              endLine: selection.end.line,
              endCharacter: selection.end.character
            }
          }
          if (sidebarProvider.addContextItem) {
            sidebarProvider.addContextItem(selectionContextItem)
          }
        } else {
          window.showInformationMessage("No text selected to add to context.")
        }
      }
    ),
    window.registerWebviewViewProvider("pointer.sidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pointer")) statusBar.refresh()
    })
  )

  statusBar.refresh()
  void providerSetup.then(() => {
    statusBar.refresh()
    logStartup(context, startedAt)
  })
}


export function deactivate() {
  logger.info("Pointer deactivated")
}
