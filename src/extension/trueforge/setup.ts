import * as vscode from "vscode"

import { logger } from "../../common/logger"
import { startEditorMcp } from "../mcp/server"
import { editorExtras } from "../mcp/sinks"

import {
  describeError,
  markServerDead,
  markServerLive,
  onAgentReady,
  registerMcpServer,
  serverName,
  setRetrievalEndpoint,
  trueforgeUrl,
  upsertAgent
} from "./client"
import { startRetrieval } from "./retrieval"

export { describeError }

type Servers = { editor?: { url: string; token: string }; retrieval?: { url: string; token: string } }

let servers: Promise<Servers> | undefined
let registered: Promise<void> | undefined
let extension: vscode.ExtensionContext | undefined

// Started once per window; each disposable is registered as soon as its server exists.
const startServers = async (context: vscode.ExtensionContext): Promise<Servers> => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!root) return {}
  const { view, extras, watcher } = editorExtras(root)
  context.subscriptions.push(watcher)
  const editorStarting = startEditorMcp({ root: view, extras }).then((editor) => {
    context.subscriptions.push({ dispose: () => void editor.dispose() })
    return editor
  })
  const retrieval = await startRetrieval(context, root, () => {
    markServerDead("pointer-retrieval")
    logger.warn("pointer-retrieval stopped; new sessions use the editor's search tools.")
  })
  if (retrieval) context.subscriptions.push(retrieval)
  return { editor: await editorStarting, retrieval }
}

const register = async (context: vscode.ExtensionContext) => {
  servers ??= startServers(context)
  const { editor, retrieval } = await servers
  if (editor) {
    await registerMcpServer(serverName("pointer-editor"), editor.url, editor.token, "Pointer's VS Code workspace: read, search, edit with review, run commands.")
    markServerLive("pointer-editor")
  }
  if (retrieval) {
    await registerMcpServer(serverName("pointer-retrieval"), retrieval.url, retrieval.token, "Ranked code retrieval: BM25, symbols and repo map, with a reason for every hit.")
    markServerLive("pointer-retrieval")
    setRetrievalEndpoint(retrieval)
    logger.info(`Retrieval MCP server at ${retrieval.url}`)
  }
  await upsertAgent()
  logger.info(`TrueForge agent registered at ${trueforgeUrl()}`)
}

// Retried on the next request after a failure, so starting TrueForge after VS Code needs no reload.
export const registerAgent = (context: vscode.ExtensionContext) => {
  extension = context
  onAgentReady(agentReady)
  registered ??= register(context).catch((error) => {
    registered = undefined
    throw error
  })
  return registered
}

export const agentReady = () => (extension ? registerAgent(extension) : Promise.resolve())
