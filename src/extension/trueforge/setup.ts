import { ChildProcess, spawn } from "child_process"
import { homedir } from "os"
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
  }).catch(async (error) => {
    // The retry starts both servers again: don't leave this window's editor server running with no owner.
    await editorStarting.then((editor) => editor.dispose(), () => undefined)
    throw error
  })
  if (retrieval) context.subscriptions.push(retrieval)
  return { editor: await editorStarting, retrieval }
}

const register = async (context: vscode.ExtensionContext) => {
  servers ??= startServers(context)
  // A failed start is retried on the next request, not cached.
  const { editor, retrieval } = await servers.catch((error) => {
    servers = undefined
    throw error
  })
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
  // Sessions carry their own spec, so a failed registration (say, an unknown model) must not take the tools down.
  await upsertAgent().then(
    () => logger.info(`TrueForge agent registered at ${trueforgeUrl()}`),
    (error) => logger.warn(`Pointer agent not registered in TrueForge: ${describeError(error)}`)
  )
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

const RECONNECT_EVERY_MS = 5_000
const RECONNECT_FOR_MS = 10 * 60_000
const DEFAULT_START = "OUTBOUND_URL_ALLOWED_HOSTS='[\"127.0.0.1\",\"localhost\"]' npx -y @truefoundry/trueforge@latest --port 8790"

const trueforgeUp = () =>
  fetch(`${trueforgeUrl()}/api/v1/agents`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false)

// Activation: register with TrueForge. If it isn't running yet, offer to start it in a terminal and keep
// checking, so Pointer connects on its own as soon as TrueForge is up, with no reload.
export const connectToTrueForge = (context: vscode.ExtensionContext) => {
  void registerAgent(context).catch(async (error) => {
    const message = describeError(error)
    logger.error(`TrueForge setup failed: ${message}`)
    if (!/can't reach TrueForge/.test(message)) {
      void vscode.window.showWarningMessage(message)
      return
    }
    const until = Date.now() + RECONNECT_FOR_MS
    const timer = setInterval(async () => {
      if (Date.now() > until) return clearInterval(timer)
      if (!(await trueforgeUp())) return
      clearInterval(timer)
      registerAgent(context).then(
        () => vscode.window.setStatusBarMessage("Pointer is connected to TrueForge", 5_000),
        (failure) => void vscode.window.showWarningMessage(`Pointer: ${describeError(failure)}`)
      )
    }, RECONNECT_EVERY_MS)
    context.subscriptions.push({ dispose: () => clearInterval(timer) })
    const pick = await vscode.window.showWarningMessage(
      `Pointer can't reach TrueForge at ${trueforgeUrl()}. It connects on its own once TrueForge is running.`,
      "Start TrueForge",
      "Setup guide"
    )
    if (pick === "Start TrueForge") startTrueForge(context)
    else if (pick === "Setup guide") {
      void vscode.env.openExternal(vscode.Uri.parse("https://github.com/pointersh/Pointer/blob/main/docs/setup.md"))
    }
  })
}

const START_TIMEOUT_MS = 120_000
let trueforge: ChildProcess | undefined

// Runs TrueForge in the background for this window (no terminal); its output goes to Pointer's log and it
// stops when the window closes. The reconnect loop above registers Pointer as soon as it answers.
const startTrueForge = (context: vscode.ExtensionContext) => {
  if (trueforge && trueforge.exitCode === null) return
  const command = vscode.workspace.getConfiguration("pointer").get<string>("trueforgeStartCommand") || DEFAULT_START
  const group = process.platform !== "win32"
  const child = spawn(command, { shell: true, cwd: homedir(), detached: group, stdio: ["ignore", "pipe", "pipe"] })
  trueforge = child
  logger.info(`Starting TrueForge: ${command}`)
  // Its normal log is noisy; keep the last lines so a failed start ("npx: command not found") is explained.
  const tail: string[] = []
  const log = (chunk: Buffer) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue
      tail.push(line.trim().slice(0, 300))
      if (tail.length > 20) tail.shift()
      if (/error|warn|listen|ready|fail/i.test(line)) logger.info(`[trueforge] ${line.trim().slice(0, 300)}`)
    }
  }
  child.stdout?.on("data", log)
  child.stderr?.on("data", log)
  child.on("error", (error) => logger.error(`TrueForge did not start: ${error.message}`))
  child.on("exit", (code, signal) => {
    logger.warn(`TrueForge exited (${signal ?? `code ${code}`})${tail.length ? `; last output:\n${tail.join("\n")}` : ""}`)
    if (trueforge === child) trueforge = undefined
  })
  context.subscriptions.push({
    dispose: () => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
      try {
        if (group) process.kill(-child.pid, "SIGTERM")
        else child.kill()
      } catch {
        // already gone
      }
    }
  })
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Starting TrueForge…" },
    async () => {
      const until = Date.now() + START_TIMEOUT_MS
      // A non-zero exit or a signal ends the wait; a command that starts TrueForge and returns (exit 0) does not.
      while (Date.now() < until && !(child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0))) {
        if (await trueforgeUp()) {
          await registerAgent(context).then(
            () => vscode.window.setStatusBarMessage("Pointer is connected to TrueForge", 5_000),
            (failure) => void vscode.window.showWarningMessage(`Pointer: ${describeError(failure)}`)
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      const action = await vscode.window.showWarningMessage(
        "TrueForge did not start. The Pointer log has its output.",
        "Show log"
      )
      if (action) logger.show()
    }
  )
}
