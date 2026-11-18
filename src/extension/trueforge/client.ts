import { TrueForge } from "@truefoundry/trueforge-sdk"
import { createHash } from "crypto"
import * as vscode from "vscode"

import agentDefinition from "../../../agent/pointer.agent.json"

export const AGENT_NAME = agentDefinition.name
export const AGENT_MANIFEST = agentDefinition.manifest

const liveServers = new Set<string>()

export const markServerLive = (name: string) => liveServers.add(name)
export const markServerDead = (name: string) => {
  liveServers.delete(name)
  if (name === "pointer-retrieval") retrieval = undefined
}

// Pointer calls retrieval itself before every agent turn (see agent.ts), so context never depends on the model asking.
let retrieval: { url: string; token: string } | undefined
export const setRetrievalEndpoint = (endpoint: { url: string; token: string }) => (retrieval = endpoint)
export const retrievalEndpoint = () => retrieval

// MCP servers are registered in TrueForge by name. Suffixing the workspace keeps two VS Code windows
// from overwriting each other's URL and token (and one window's agent editing the other's files).
const workspaceTag = createHash("sha1")
  .update(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "")
  .digest("hex")
  .slice(0, 8)
export const serverName = (name: string) => `${name}-${workspaceTag}`

// Set by setup.ts once activation starts registering; the agent awaits it before each turn.
let readiness: () => Promise<void> = async () => undefined
export const onAgentReady = (ready: () => Promise<void>) => (readiness = ready)
export const agentReady = () => readiness()

const REASONING_DEFAULTS: Record<string, string> = { "pointer/primary": "none", "pointer-backup/primary": "low", "pointer-groq/primary": "low", "google-gemini/primary": "medium" }

export const modelSpec = (name: string) => {
  const effort = { ...REASONING_DEFAULTS, ...vscode.workspace.getConfiguration("pointer").get<Record<string, string>>("reasoningEffort") }[name]
  return { name, params: { parallel_tool_calls: true, ...(effort ? { reasoning_effort: effort } : {}) } }
}

export const agentManifest = () => ({
  ...AGENT_MANIFEST,
  model: modelSpec(AGENT_MANIFEST.model.name),
  mcp_servers: AGENT_MANIFEST.mcp_servers
    .filter((server) => liveServers.has(server.name))
    .map((server) => ({
      ...server,
      name: serverName(server.name),
      ...(server.name === "pointer-editor" && liveServers.has("pointer-retrieval") ? { disable_tools: ["find_symbol"] } : {})
    }))
})

const settings = () => vscode.workspace.getConfiguration("pointer")

export const trueforgeUrl = () => (settings().get<string>("trueforgeUrl") || "http://localhost:8790").replace(/\/$/, "")

export const modelChain = (): string[] => {
  const configured = settings().get<string[]>("models") ?? []
  return configured.length ? configured : [AGENT_MANIFEST.model.name, "pointer-backup/primary"]
}

// Inline edits are one short call: a fast model can serve them while agent mode keeps a stronger chain.
export const inlineModelChain = (): string[] => {
  const configured = settings().get<string[]>("inlineModels") ?? []
  return configured.length ? configured : modelChain()
}

export const chooseModel = async (name: string) => {
  await settings().update("models", [name, ...modelChain().filter((model) => model !== name)], vscode.ConfigurationTarget.Global)
  return modelChain()
}

export const trueforge = () => new TrueForge({ baseUrl: trueforgeUrl(), timeoutInSeconds: 900 })

const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${trueforgeUrl()}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`TrueForge ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : undefined) as T
}

export const registerMcpServer = (name: string, url: string, token: string, description: string) =>
  api("PUT", "/api/v1/settings/mcp-servers", {
    manifest: { type: "remote", name, url, description, auth: { type: "header", headers: { Authorization: `Bearer ${token}` } } }
  })

export const upsertAgent = async () => {
  for await (const agent of await trueforge().agents.list()) {
    if (agent.name === AGENT_NAME) {
      return api("PUT", `/api/v1/agents/${agent.id}`, { description: AGENT_DESCRIPTION, manifest: agentManifest() })
    }
  }
  return api("POST", "/api/v1/agents", { name: AGENT_NAME, description: AGENT_DESCRIPTION, manifest: agentManifest() })
}

const AGENT_DESCRIPTION = "Pointer: editor-native coding agent for VS Code."

export const describeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/.test(message)) {
    return `Pointer can't reach TrueForge at ${trueforgeUrl()}. Start it with \`npx @truefoundry/trueforge@latest\`.`
  }
  return message
}
