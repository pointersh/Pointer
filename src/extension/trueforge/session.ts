import { isEventDelta, mergeEventDelta, TrueForgeApi } from "@truefoundry/trueforge-sdk"

import { trueforge, trueforgeUrl } from "./client"

type Event = TrueForgeApi.TurnStreamingEvent

interface InlineSpec {
  model: { name: string }
  instructions?: string
  mcp_servers?: unknown[]
  messages?: { type: "user.message"; content: string }[]
  config?: Record<string, unknown>
}

export const createSession = async (agent: { name: string } | { spec: InlineSpec }): Promise<string> => {
  const response = await fetch(`${trueforgeUrl()}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent })
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`TrueForge could not create a session (${response.status}): ${body.slice(0, 300)}`)
  const parsed = JSON.parse(body)
  return parsed.data?.id ?? parsed.id
}

interface TurnHandlers {
  withThinking?: boolean
  onText?(text: string): void
  onToolCall?(call: { id: string; name: string; args: Record<string, string> }): void
  onToolResult?(id: string, output: string): void
  onApproval?(callId: string, threadId: string): Promise<boolean>
}

export interface TurnResult {
  status: "done" | "cancelled" | "error"
  text: string
  error?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
}

const textOf = (content: TrueForgeApi.ModelMessageEventContent | null | undefined) =>
  typeof content === "string" ? content : (content ?? []).map((part) => ("text" in part ? part.text : "")).join("")

const toolName = (call: TrueForgeApi.ToolCall, args: Record<string, string>) => {
  const name = call.toolInfo?.type === "mcp" ? call.toolInfo.name : call.function.name
  return name === "call_tool" && args.tool_name ? args.tool_name : name
}

const parseArgs = (raw: string): Record<string, string> => {
  try {
    const value = JSON.parse(raw || "{}")
    const args = value && typeof value === "object" && "arguments" in value && typeof value.arguments === "object" ? { ...value, ...value.arguments } : value
    return Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))
  } catch {
    return {}
  }
}

export const runTurn = async (sessionId: string, input: string, handlers: TurnHandlers, signal: AbortSignal): Promise<TurnResult> => {
  const client = trueforge()
  const messages = new Map<string, Event>()
  const calls = new Map<string, TrueForgeApi.ToolCall>()
  const announced = new Set<string>()
  let mainThread: string | null = null
  let turnId: string | undefined
  let lastEventId: string | undefined
  const result: TurnResult = { status: "error", text: "" }

  const mainText = (thinking = handlers.withThinking) =>
    [...messages.values()]
      .filter((m) => m.type === "model.message" && m.threadId === mainThread)
      .map((m) => {
        const message = m as TrueForgeApi.ModelMessageEvent
        const reasoning = thinking && message.reasoningContent ? `<think>${message.reasoningContent}</think>` : ""
        return reasoning + textOf(message.content)
      })
      .join("")

  const handle = async (event: Event): Promise<"next" | "done" | "resubscribe"> => {
    lastEventId = event.id
    if (event.type === "turn.created") {
      turnId = event.turnId
      mainThread = event.threadId
      return "next"
    }
    if (isEventDelta(event)) {
      const base = messages.get(event.id)
      if (base) mergeEventDelta(base, event)
    } else if (event.type === "model.message") {
      messages.set(event.id, event)
      mainThread ??= event.threadId
      result.model = event.model?.name ?? result.model
    }
    if (event.type === "model.message" || isEventDelta(event)) {
      const message = messages.get(event.id) as TrueForgeApi.ModelMessageEvent | undefined
      if (message?.threadId === mainThread) handlers.onText?.(mainText())
      for (const call of message?.toolCalls ?? []) {
        calls.set(call.id, call)
        if (!announced.has(call.id) && message?.finishReason) {
          announced.add(call.id)
          const args = parseArgs(call.function.arguments)
          handlers.onToolCall?.({ id: call.id, name: toolName(call, args), args })
        }
      }
      if (message?.usage) {
        result.promptTokens = message.usage.inputTokens ?? result.promptTokens
        result.completionTokens = message.usage.outputTokens ?? result.completionTokens
      }
      return "next"
    }
    if (event.type === "tool.response") {
      handlers.onToolResult?.(event.toolCallId, event.content)
      return "next"
    }
    if (event.type === "tool.approval_required") {
      for (const ref of event.toolCalls) {
        const call = calls.get(ref.id)
        if (call && !announced.has(call.id)) {
          announced.add(call.id)
          const args = parseArgs(call.function.arguments)
          handlers.onToolCall?.({ id: call.id, name: toolName(call, args), args })
        }
        const allow = (await handlers.onApproval?.(ref.id, event.threadId)) ?? false
        await client.sessions.createTurnEvents(sessionId, turnId!, {
          events: [
            {
              type: "user.tool_approval",
              threadId: event.threadId,
              toolCallId: ref.id,
              approval: allow ? { status: "allow" } : { status: "deny", reason: "The user rejected this change." }
            }
          ]
        })
      }
      return "resubscribe"
    }
    if (event.type === "turn.done") {
      const state = event.state
      result.status = state.status
      if (state.status === "error") result.error = state.message
      return "done"
    }
    return "next"
  }

  let stream = await client.sessions.createTurnStream(sessionId, { input: [{ type: "user.message", content: input }] }, { abortSignal: signal })
  for (;;) {
    let finished = false
    try {
      for await (const event of stream) {
        const next = await handle(event)
        if (next === "next") continue
        finished = next === "done"
        break
      }
    } catch (error) {
      if (signal.aborted) return { ...result, status: "cancelled", text: mainText() }
      throw error
    }
    if (finished || !turnId || signal.aborted) break
    stream = await client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId: lastEventId }, { abortSignal: signal })
  }
  result.text = mainText()
  if (signal.aborted && result.status !== "done") result.status = "cancelled"
  return result
}

export const cancelSession = (sessionId: string) => trueforge().sessions.cancel(sessionId).catch(() => undefined)
