import * as vscode from "vscode"

import { logger } from "../../common/logger"
import { startEditorMcp } from "../mcp/server"
import { editorExtras } from "../mcp/sinks"

import { describeError, markServerLive, registerMcpServer, trueforgeUrl, upsertAgent } from "./client"
import { startRetrieval } from "./retrieval"

export { describeError }

export const registerAgent = async (context: vscode.ExtensionContext) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (root) {
    const { view, extras } = editorExtras(root)
    const [editor, retrieval] = await Promise.all([startEditorMcp({ root: view, extras }), startRetrieval(context, root)])
    context.subscriptions.push({ dispose: () => void editor.dispose() })
    await registerMcpServer("pointer-editor", editor.url, editor.token, "Pointer's VS Code workspace: read, search, edit with review, run commands.")
    markServerLive("pointer-editor")
    if (retrieval) {
      context.subscriptions.push(retrieval)
      await registerMcpServer("pointer-retrieval", retrieval.url, retrieval.token, "Ranked code retrieval: BM25, symbols and repo map, with a reason for every hit.")
      markServerLive("pointer-retrieval")
      logger.info(`Retrieval MCP server at ${retrieval.url}`)
    }
  }
  await upsertAgent()
  logger.info(`TrueForge agent registered at ${trueforgeUrl()}`)
}
