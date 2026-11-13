import { TrueForge } from "@truefoundry/trueforge-sdk"
import * as vscode from "vscode"

import agentDefinition from "../../../agent/pointer.agent.json"

export const AGENT_NAME = agentDefinition.name
export const AGENT_MANIFEST = agentDefinition.manifest

const settings = () => vscode.workspace.getConfiguration("pointer")

export const trueforgeUrl = () => (settings().get<string>("trueforgeUrl") || "http://localhost:8790").replace(/\/$/, "")

export const modelChain = (): string[] => {
  const configured = settings().get<string[]>("models") ?? []
  return configured.length ? configured : [AGENT_MANIFEST.model.name, "pointer/fallback"]
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
      return api("PUT", `/api/v1/agents/${agent.id}`, { description: AGENT_DESCRIPTION, manifest: AGENT_MANIFEST })
    }
  }
  return api("POST", "/api/v1/agents", { name: AGENT_NAME, description: AGENT_DESCRIPTION, manifest: AGENT_MANIFEST })
}

const AGENT_DESCRIPTION = "Pointer: editor-native coding agent for VS Code."

export const describeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/.test(message)) {
    return `Pointer can't reach TrueForge at ${trueforgeUrl()}. Start it with \`npx @truefoundry/trueforge@latest\`.`
  }
  return message
}
