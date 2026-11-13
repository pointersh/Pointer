import { ChildProcess, spawn } from "child_process"

import type { ToolParameter, ToolSpec } from "./protocol"

export const MCP_PROTOCOL_VERSION = "2025-06-18"
const START_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 30_000
const MAX_DESCRIPTION_CHARS = 200
export const MANY_MCP_TOOLS = 20
const MAX_LIST_PAGES = 20
const MAX_STDERR_CHARS = 4000

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  [key: string]: unknown
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: JsonSchema
}

export interface McpCallResult {
  text: string
  isError: boolean
}

interface Pending {
  resolve(result: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface McpClientOptions {
  cwd: string
  startTimeoutMs?: number
  callTimeoutMs?: number
  onStderr?(text: string): void
}

export class McpClient {
  private _child?: ChildProcess
  private _nextId = 1
  private readonly _pending = new Map<number, Pending>()
  private _buffer = ""
  private _ended?: string
  private _started?: Promise<void>

  constructor(
    readonly name: string,
    private readonly _config: McpServerConfig,
    private readonly _options: McpClientOptions
  ) {}

  start(): Promise<void> {
    this._started ??= this.begin().catch((error) => {
      this.close()
      throw error
    })
    return this._started
  }

  private async begin() {
    const child = spawn(this._config.command, this._config.args ?? [], {
      cwd: this._config.cwd ?? this._options.cwd,
      env: { ...process.env, ...this._config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    })
    this._child = child
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.receive(chunk))
    child.stderr?.on("data", (chunk: string) => this._options.onStderr?.(chunk.slice(-MAX_STDERR_CHARS)))
    child.on("error", (error) => this.end(`it could not start: ${error.message}`))
    child.on("exit", (code, signal) => this.end(`it exited${signal ? ` on ${signal}` : ` with code ${code}`}`))
    child.stdin?.on("error", () => undefined)
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pointer", version: "1" }
      },
      this._options.startTimeoutMs ?? START_TIMEOUT_MS
    )
    this.notify("notifications/initialized")
  }

  async listTools(): Promise<McpTool[]> {
    await this.start()
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpTool[]
        nextCursor?: string
      }
      for (const tool of result?.tools ?? []) if (tool && typeof tool.name === "string") tools.push(tool)
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    await this.start()
    const result = (await this.request("tools/call", { name, arguments: args }, undefined, signal)) as {
      content?: unknown[]
      isError?: boolean
      structuredContent?: unknown
    }
    return { text: contentText(result), isError: result?.isError === true }
  }

  close() {
    this.end("it was closed")
    const child = this._child
    if (child && child.exitCode === null && !child.killed) {
      child.stdin?.end()
      child.kill()
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    if (this._ended) return Promise.reject(new Error(`The MCP server ${this.name} is not running: ${this._ended}.`))
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? this._options.callTimeoutMs ?? CALL_TIMEOUT_MS
      const settle = () => {
        this._pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        settle()
        this.notify("notifications/cancelled", { requestId: id, reason: "The user stopped the reply." })
        reject(new Error("Stopped by the user."))
      }
      const timer = setTimeout(() => {
        settle()
        this.notify("notifications/cancelled", { requestId: id, reason: "Timed out." })
        reject(new Error(`The MCP server ${this.name} did not answer ${method} within ${Math.round(limit / 1000)} s.`))
      }, limit)
      this._pending.set(id, {
        resolve: (result) => {
          settle()
          resolve(result)
        },
        reject: (error) => {
          settle()
          reject(error)
        },
        timer
      })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  private notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  private send(message: unknown) {
    const stdin = this._child?.stdin
    if (!stdin || stdin.destroyed || this._ended) return
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(chunk: string) {
    this._buffer += chunk
    let newline = this._buffer.indexOf("\n")
    while (newline !== -1) {
      const line = this._buffer.slice(0, newline).trim()
      this._buffer = this._buffer.slice(newline + 1)
      if (line) this.handle(line)
      newline = this._buffer.indexOf("\n")
    }
  }

  private handle(line: string) {
    let message: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        this.send(
          message.method === "ping"
            ? { jsonrpc: "2.0", id: message.id, result: {} }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `pointer does not offer ${message.method}.` } }
        )
      }
      return
    }
    const pending = typeof message.id === "number" ? this._pending.get(message.id) : undefined
    if (!pending) return
    if (message.error) pending.reject(new Error(message.error.message || "The MCP server reported an error."))
    else pending.resolve(message.result)
  }

  private end(reason: string) {
    if (this._ended) return
    this._ended = reason
    for (const pending of this._pending.values()) pending.reject(new Error(`The MCP server ${this.name} stopped: ${reason}.`))
    this._pending.clear()
  }
}

export const contentText = (result: { content?: unknown[]; structuredContent?: unknown } | undefined): string => {
  const parts = (result?.content ?? []).map((item) => {
    const part = item as { type?: string; text?: string; name?: string; uri?: string; resource?: { uri?: string; text?: string } }
    if (part.type === "text" && typeof part.text === "string") return part.text
    if (part.type === "image") return "[image]"
    if (part.type === "audio") return "[audio]"
    if (part.type === "resource") return part.resource?.text ?? `[resource ${part.resource?.uri ?? ""}]`.trim()
    if (part.type === "resource_link") return `[resource ${part.name ?? part.uri ?? ""}]`.trim()
    return ""
  })
  const text = parts.filter(Boolean).join("\n")
  if (text) return text
  return result?.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent)
}

export const qualifiedToolName = (server: string, tool: string) =>
  `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)

const clipDescription = (text: string | undefined) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : flat
}

const typeOf = (schema: JsonSchema | undefined) => (Array.isArray(schema?.type) ? schema?.type[0] : schema?.type)

export const coerceArguments = (schema: JsonSchema | undefined, args: Record<string, string>): Record<string, unknown> => {
  const properties = schema?.properties ?? {}
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => {
      const type = typeOf(properties[name])
      if (type === "number" || type === "integer") {
        const number = Number(value)
        return [name, Number.isFinite(number) && value.trim() !== "" ? number : value]
      }
      if (type === "boolean") return [name, value === "true" ? true : value === "false" ? false : value]
      if (type === "object" || type === "array" || type === "null") {
        try {
          return [name, JSON.parse(value)]
        } catch {
          return [name, value]
        }
      }
      return [name, value]
    })
  )
}

export interface McpToolSpec extends ToolSpec {
  server: string
  tool: string
}

export const mcpToolSpecs = (server: string, tools: McpTool[], taken: Set<string>): McpToolSpec[] =>
  tools.flatMap((tool) => {
    let name = qualifiedToolName(server, tool.name)
    for (let n = 2; taken.has(name); n++) name = `${qualifiedToolName(server, tool.name).slice(0, 60)}_${n}`
    taken.add(name)
    const schema: JsonSchema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" }
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const parameters: ToolParameter[] = Object.entries(schema.properties ?? {}).map(([parameter, property]) => ({
      name: parameter,
      description: clipDescription(property?.description) || parameter,
      ...(required.has(parameter) ? {} : { optional: true })
    }))
    return [
      {
        name,
        server,
        tool: tool.name,
        description: `${clipDescription(tool.description) || tool.name} (from the MCP server ${server})`,
        parameters,
        schema: { type: "object", ...schema }
      }
    ]
  })
