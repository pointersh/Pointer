import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { randomUUID } from "crypto"
import * as http from "http"
import { AddressInfo } from "net"

import { WorkspaceView } from "../tools/view"
import { Tool, ToolExtras, workspaceTools } from "../tools/workspace"

export interface EditorMcpOptions {
  root: string | WorkspaceView
  extras: ToolExtras
}

export interface EditorMcp {
  url: string
  token: string
  dispose(): Promise<void>
}

const DESTRUCTIVE = new Set(["edit_file", "create_file", "rename_symbol", "move_file", "delete_file", "run_command"])

const inputSchema = (tool: Tool) =>
  tool.schema ?? {
    type: "object",
    properties: Object.fromEntries(
      tool.parameters.map((p) => [p.name, { type: p.type ?? "string", description: p.description, ...p.schema }])
    ),
    required: tool.parameters.filter((p) => !p.optional).map((p) => p.name)
  }

const annotations = (tool: Tool) =>
  tool.readOnly && !tool.acts
    ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: DESTRUCTIVE.has(tool.name) || !!tool.acts, openWorldHint: false }

const asStrings = (args: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries(args)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
  )

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

const mcpServer = (tools: Tool[]) => {
  const server = new Server({ name: "pointer-editor", version: "0.1.0" }, { capabilities: { tools: {} } })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.guidance ? `${tool.description}\n\n${tool.guidance}` : tool.description,
      inputSchema: inputSchema(tool) as { type: "object" },
      annotations: annotations(tool)
    }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name)
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true }
    const result = await tool.run(asStrings(request.params.arguments), { signal: extra.signal })
    return { content: [{ type: "text", text: result.output }], isError: !!result.failed }
  })
  return server
}

export const startEditorMcp = async ({ root, extras }: EditorMcpOptions): Promise<EditorMcp> => {
  const { tools } = workspaceTools(root, [], extras)
  const token = randomUUID()
  const httpServer = http.createServer(async (req, res) => {
    const origin = req.headers.origin
    if (req.headers.authorization !== `Bearer ${token}` || (origin && !LOOPBACK.test(origin))) {
      res.writeHead(401).end()
      return
    }
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end()
      return
    }
    const server = mcpServer(tools)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error))
    }
  })
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
  const { port } = httpServer.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    dispose: () => new Promise((resolve) => httpServer.close(() => resolve()))
  }
}
