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

// The registered agent is the definition people see in TrueForge; sessions use an inline spec, so it names
// the first model of the user's chain rather than a fixed provider.
export const upsertAgent = async () => {
  const manifest = { ...agentManifest(), model: modelSpec(modelChain()[0]) }
  for await (const agent of await trueforge().agents.list()) {
    if (agent.name === AGENT_NAME) {
      return api("PUT", `/api/v1/agents/${agent.id}`, { description: AGENT_DESCRIPTION, manifest })
    }
  }
  return api("POST", "/api/v1/agents", { name: AGENT_NAME, description: AGENT_DESCRIPTION, manifest })
}

const AGENT_DESCRIPTION = "Pointer: editor-native coding agent for VS Code."

export const describeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/.test(message)) {
    return `Pointer can't reach TrueForge at ${trueforgeUrl()}. Start it with \`npx @truefoundry/trueforge@latest\`.`
  }
  // TrueForge's outbound allowlist: without loopback it refuses Pointer's own tool servers; without the
  // provider's host it refuses the model.
  const blocked = /Outbound URL blocked for host \\?"([^"\\]+)/.exec(message)
  if (blocked) {
    return `TrueForge is blocking ${blocked[1]}. Restart it with that host allowed: OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost","your.model.host"]' npx @truefoundry/trueforge@latest --port 8790 (see docs/setup.md).`
  }
  const unknownModel = /Unknown model \\?"([^"\\]+)/.exec(message)
  if (unknownModel) {
    return `TrueForge has no model "${unknownModel[1]}". Register a provider for it (docs/setup.md, step 2), or set pointer.models to models you have.`
  }
  return message
}
