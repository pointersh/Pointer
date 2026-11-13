import * as vscode from "vscode"

import { logger } from "../../common/logger"
import { startEditorMcp } from "../mcp/server"
import { editorExtras } from "../mcp/sinks"

import { describeError, registerMcpServer, trueforgeUrl, upsertAgent } from "./client"

export { describeError }

export const EDITOR_MCP_NAME = "pointer-editor"

export const registerAgent = async (context: vscode.ExtensionContext) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (root) {
    const { view, extras } = editorExtras(root, async () => true)
    const mcp = await startEditorMcp({ root: view, extras })
    context.subscriptions.push({ dispose: () => void mcp.dispose() })
    await registerMcpServer(EDITOR_MCP_NAME, mcp.url, mcp.token, "Pointer's VS Code workspace: read, search, edit with review, run commands.")
    logger.info(`Editor MCP server at ${mcp.url}`)
  }
  await upsertAgent()
  logger.info(`TrueForge agent registered at ${trueforgeUrl()}`)
}
