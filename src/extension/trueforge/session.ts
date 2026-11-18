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
    body: JSON.stringify({ agent }),
    signal: AbortSignal.timeout(30_000)
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
  modelCalls?: number
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

const SETTLE_POLL_MS = 1000
// Every delta re-joins the whole reply; emitting each one is quadratic over a long turn. At most one update per 50 ms.
const TEXT_EVERY_MS = 50
// Seen live on Makora: a call that sends nothing for minutes, and a reply that keeps streaming reasoning
// for minutes without finishing. Both count as a failed turn after this long without progress (a new
// message, a finished reply, a tool result), so the agent falls back to the next model. Streamed deltas
// alone are not progress. Healthy runs never went 20 s without progress, so a silent model gets 60 s; while
// a tool runs the limit covers the 120 s command timeout. Waiting on the user's approval doesn't count.
const STALL_MS = 60_000
const TOOL_STALL_MS = 150_000
const MAX_RECONNECTS = 3

export const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i
export const RATE_LIMIT_RETRIES = 2

export const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })

export const retryDelay = (error: string, attempt: number) =>
  Math.min(20, Number(/retry (?:in|after) (\d+)/i.exec(error)?.[1]) || 2 * 2 ** attempt)

export const runTurn = async (sessionId: string, input: string, handlers: TurnHandlers, signal: AbortSignal): Promise<TurnResult> => {
  // An abort listener added to an already-aborted signal never fires: a turn stopped before it began must not start.
  if (signal.aborted) return { status: "cancelled", text: "" }
  const client = trueforge()
  const messages = new Map<string, Event>()
  const calls = new Map<string, TrueForgeApi.ToolCall>()
  const announced = new Set<string>()
  // Tool calls announced but not yet answered: while one runs, silence is the tool working, not a stall.
  const running = new Set<string>()
  const usage = new Map<string, NonNullable<TrueForgeApi.ModelMessageEvent["usage"]>>()
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

  let lastText = 0
  let textTimer: ReturnType<typeof setTimeout> | undefined
  let textDirty = false
  const flushText = () => {
    if (textTimer) clearTimeout(textTimer)
    textTimer = undefined
    if (!textDirty) return
    textDirty = false
    lastText = Date.now()
    handlers.onText?.(mainText())
  }
  const scheduleText = () => {
    textDirty = true
    const wait = TEXT_EVERY_MS - (Date.now() - lastText)
    if (wait <= 0) flushText()
    else textTimer ??= setTimeout(flushText, wait)
  }

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
      if (message?.threadId === mainThread) scheduleText()
      for (const call of message?.toolCalls ?? []) {
        calls.set(call.id, call)
        if (!announced.has(call.id) && message?.finishReason) {
          announced.add(call.id)
          running.add(call.id)
          const args = parseArgs(call.function.arguments)
          handlers.onToolCall?.({ id: call.id, name: toolName(call, args), args })
        }
      }
      // Each model call resends the whole context, so the turn's cost is the sum over calls, not the last one.
      if (message?.usage) {
        usage.set(message.id, message.usage)
        result.promptTokens = [...usage.values()].reduce((n, u) => n + (u.inputTokens ?? 0), 0)
        result.completionTokens = [...usage.values()].reduce((n, u) => n + (u.outputTokens ?? 0), 0)
        result.modelCalls = usage.size
      }
      return "next"
    }
    if (event.type === "tool.response") {
      running.delete(event.toolCallId)
      handlers.onToolResult?.(event.toolCallId, event.content)
      return "next"
    }
    if (event.type === "tool.approval_required") {
      for (const ref of event.toolCalls) {
        // After Stop, nobody can answer the rest; the session is being cancelled anyway.
        if (signal.aborted || !turnId) break
        const call = calls.get(ref.id)
        if (!announced.has(ref.id)) {
          announced.add(ref.id)
          running.add(ref.id)
          // A call we never saw streamed still gets a step, so its approval card has somewhere to live.
          const args = call ? parseArgs(call.function.arguments) : {}
          handlers.onToolCall?.({ id: ref.id, name: call ? toolName(call, args) : "tool", args })
        }
        const allow = (await handlers.onApproval?.(ref.id, event.threadId)) ?? false
        if (signal.aborted) break
        await client.sessions.createTurnEvents(sessionId, turnId, {
          events: [
            {
              type: "user.tool_approval",
              threadId: event.threadId,
              toolCallId: ref.id,
              approval: allow ? { status: "allow" } : { status: "deny", reason: "The user rejected this change." }
            }
          ]
        }, { abortSignal: signal })
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

  const settledTurn = async (stop: AbortSignal) => {
    while (!stop.aborted) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
      if (stop.aborted) return undefined
      const turn = await client.sessions.getTurn(sessionId, turnId!).catch(() => undefined)
      const state = turn?.data.state
      if (state && state.status !== "running" && state.status !== "paused") return state
    }
    return undefined
  }

  let watch: AbortController | undefined = new AbortController()
  let stalled = false
  let reconnects = 0
  let idle: ReturnType<typeof setTimeout> | undefined
  let limit = STALL_MS
  const quiet = () => clearTimeout(idle)
  const arm = () => {
    quiet()
    limit = running.size ? TOOL_STALL_MS : STALL_MS
    idle = setTimeout(() => {
      stalled = true
      watch?.abort()
    }, limit)
  }
  let stream = await client.sessions.createTurnStream(sessionId, { input: [{ type: "user.message", content: input }] }, { abortSignal: watch.signal })
  let settled: Awaited<ReturnType<typeof settledTurn>>
  let fallback = ""
  signal.addEventListener("abort", () => watch?.abort(), { once: true })
  for (;;) {
    let finished = false
    let events = 0
    try {
      arm()
      for await (const event of stream) {
        events++
        const delta = isEventDelta(event)
        if (!delta) quiet()
        const next = await handle(event)
        const replied = delta && !!(messages.get(event.id) as TrueForgeApi.ModelMessageEvent | undefined)?.finishReason
        if (!delta || replied) arm()
        if (next === "next") continue
        finished = next === "done"
        break
      }
    } catch (error) {
      quiet()
      if (stalled) {
        flushText()
        return { ...result, status: "error", error: `The model made no progress for ${limit / 1000} s.`, text: mainText() }
      }
      if (signal.aborted) {
        flushText()
        return { ...result, status: "cancelled", text: mainText() }
      }
      // A dropped stream (undici "terminated") doesn't end the turn on the server: pick it up again
      // from the last event received, a few times, before calling the turn failed.
      if (!settled) {
        if (!turnId || reconnects >= MAX_RECONNECTS) {
          flushText()
          throw error
        }
        reconnects++
        await pause(500 * reconnects, signal)
      }
    }
    quiet()
    watch?.abort()
    if (settled && !finished) {
      result.status = settled.status === "done" ? "done" : settled.status === "error" ? "error" : "cancelled"
      if (settled.status === "error") result.error = settled.message
      if (settled.status === "done" && settled.output) fallback = textOf(settled.output.content)
      break
    }
    if (finished || !turnId || signal.aborted) break
    // A subscription that ends at once with nothing must not turn into a tight resubscribe loop.
    if (!events) await pause(500, signal)
    if (signal.aborted) break
    const current = new AbortController()
    watch = current
    stream = await client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId: lastEventId }, { abortSignal: current.signal })
    void settledTurn(current.signal).then((state) => {
      if (!state) return
      settled = state
      current.abort()
    })
  }
  flushText()
  result.text = mainText() || fallback
  if (signal.aborted && result.status !== "done") result.status = "cancelled"
  return result
}

export const cancelSession = (sessionId: string) => trueforge().sessions.cancel(sessionId).catch(() => undefined)
