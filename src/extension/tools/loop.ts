import { API_PROVIDERS, ASSISTANT, DEFAULT_AGENT_STEPS, OPEN_AI_COMPATIBLE_PROVIDERS, SYSTEM, USER } from "../../common/constants"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import {
  ChatChunk,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  InferenceClient,
  InferenceError,
  InferenceOptions,
  isCancelled
} from "../inference"
import { hostedTakesTools } from "../inference/adapters/fluency"

import { compactHistory, ContextPlan, fitResult, MIN_TRIMMABLE_CHARS, planContext, TokenEstimator, trimmedResult } from "./budget"
import { instructionsSection } from "./instructions"
import {
  displayableLength,
  FINAL_ANSWER_PROMPT,
  findFencedCall,
  findToolCall,
  FoundCall,
  nameArguments,
  parseLenientJson,
  ToolCall,
  toolDefinition,
  toolInstructions,
  toolResultMessage,
  ToolSpec} from "./protocol"
import { parseTasks, renderTasks, sameTasks, Task, TASKS_TOOL, TASKS_TOOL_NAME, tasksProgress } from "./tasks"
import { ToolResult, WorkspaceTools } from "./workspace"

export const DEFAULT_MAX_STEPS = DEFAULT_AGENT_STEPS
const MAX_CALLS_PER_REPLY = 8
const MIN_RESULT_CHARS = 1000
const MAX_REPEATED_CALLS = 3
const MAX_UNREADABLE_IN_A_ROW = 3

export type ToolMode = "native" | "text"

const NATIVE_TOOL_KINDS = new Set<string>([
  ...Object.values(OPEN_AI_COMPATIBLE_PROVIDERS).filter(
    (kind) =>
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.Qvac &&
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.Oobabooga
  ),
  API_PROVIDERS.OpenAI
])

export const toolModeFor = (providerKind: string): ToolMode =>
  NATIVE_TOOL_KINDS.has(providerKind) ||
  (HOSTED_PROVIDERS.includes(providerKind) && hostedTakesTools(providerKind))
    ? "native"
    : "text"

export interface ToolStep {
  id: string
  index: number
  mode: ToolMode
  name?: string
  args?: Record<string, string>
  parseError?: string
  summary: string
  output: string
  failed?: boolean
  promptChars: number
}

export interface ToolStart {
  id: string
  name: string
  args: Record<string, string>
}

export interface ToolLoopUsage {
  promptTokens?: number
  completionTokens?: number
}

export interface ToolLoopOptions {
  mode?: ToolMode
  maxSteps?: number
  contextWindow?(): Promise<number | undefined> | number | undefined
  stepLines?: boolean
  reasoningEffort?: ChatRequest["reasoningEffort"]
  onToolStart?(start: ToolStart): void
  onStep?(step: ToolStep): void
  onRequest?(promptChars: number, step: number, mode: ToolMode, estimatedTokens: number): void
  onUsage?(usage: ToolLoopUsage): void
  onFallback?(reason: string, what: "tools" | "reasoning-effort"): void
  onTrim?(results: number, estimatedTokens: number): void
  onCompact?(messages: number): void
  tasks?: boolean
  onTasks?(tasks: Task[]): void
  steering?(): string[]
  onOutOfSteps?(): void
  onNotes?(notes: string | undefined): void
  onEnd?(): void
}

const clipTo = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}… (cut)` : text

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : ""

type NativeCall = { id: string; type: "function"; function: { name: string; arguments: string } }

const callsOf = (message: ChatMessage): NativeCall[] =>
  (message as { tool_calls?: NativeCall[] }).tool_calls ?? []

const charsOf = (messages: ChatMessage[]) =>
  messages.reduce(
    (sum, m) =>
      sum +
      textOf(m.content).length +
      callsOf(m).reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0),
    0
  )

const withToolPrompt = (messages: ChatMessage[], section: string): ChatMessage[] => {
  const [first, ...rest] = messages
  if (first?.role === SYSTEM) {
    return [{ role: SYSTEM, content: `${textOf(first.content).trim()}\n\n${section}` }, ...rest]
  }
  return [{ role: SYSTEM, content: section }, ...messages]
}

const withClosingPrompt = (messages: ChatMessage[], prompt: string): ChatMessage[] => {
  const final = messages[messages.length - 1]
  return final?.role === USER && typeof final.content === "string"
    ? [...messages.slice(0, -1), { ...final, content: `${final.content}\n\n${prompt}` }]
    : [...messages, { role: USER, content: prompt }]
}

const MAX_LEDGER_LINES = 20

const stepLine = (summary: string) => `> ${summary}\n\n`

export const steeringMessage = (said: string[]) =>
  [
    `While you were working, the user wrote${said.length > 1 ? " these messages" : ""}:`,
    ...said.map((text) => `\n${text}`),
    "\nTake that into account and carry on."
  ].join("\n")

const withoutCalls = (text: string): { lead: string; after: string[] } => {
  const pieces: string[] = []
  let rest = text
  for (let found = findToolCall(rest, true); found; found = findToolCall(rest, true)) {
    pieces.push(rest.slice(0, found.start))
    rest = rest.slice(found.end)
  }
  const [lead, ...after] = [...pieces, rest]
  return { lead: lead.trimEnd(), after: after.map((piece) => piece.trim()).filter(Boolean) }
}

const gapAfter = (shown: string) =>
  !shown.trim() || shown.endsWith("\n\n") ? "" : shown.endsWith("\n") ? "\n" : "\n\n"

const mentionsTools = (error: unknown) =>
  !isCancelled(error) && error instanceof Error && /\btools?\b|function.?call/i.test(error.message)

const refusesReasoningEffort = (error: unknown) =>
  !isCancelled(error) &&
  error instanceof Error &&
  /reasoning[._ ]?effort/i.test(error.message) &&
  !/function tools|\btools\b/i.test(error.message)

const cancelled = (reason?: unknown) =>
  new InferenceError("cancelled", "The request was cancelled.", { cause: reason })

const parseArguments = (call: ChatToolCall): ToolCall | { error: string; detail?: string } => {
  if (!call.arguments.trim()) return { name: call.name, args: {} }
  const parsed = parseLenientJson(call.arguments)
  if ("error" in parsed) return { error: "the arguments were not valid JSON", detail: parsed.error }
  const { value } = parsed
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "the arguments were not an object" }
  return {
    name: call.name,
    args: Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
    )
  }
}

const MAX_QUOTED_CALL = 600

export const unreadableCallMessage = (pending: { error?: string; detail?: string; written?: string }, native: boolean) => {
  const why = `Your tool call could not be read: ${pending.error}${pending.detail ? ` (${pending.detail})` : ""}.`
  const written = pending.written?.trim()
  const quoted = written
    ? `\nYou wrote:\n~~~\n${written.length > MAX_QUOTED_CALL ? `${written.slice(0, MAX_QUOTED_CALL)}… (${written.length - MAX_QUOTED_CALL} more characters)` : written}\n~~~`
    : ""
  const form = native
    ? ""
    : "\nWrite it exactly like this, as JSON, with line breaks inside strings written as \\n:\n```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"src/index.ts\"}}\n```"
  return `${why}${quoted}${form}`
}

const strictJson = (text: string) => {
  if (!text.trim()) return true
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const parsedOr = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

export const flattenToolHistory = (messages: ChatMessage[]): ChatMessage[] => {
  const names = new Map<string, string>()
  const flat: { role: string; content: ChatMessage["content"]; own: boolean }[] = []
  const add = (role: string, content: string) => {
    const previous = flat[flat.length - 1]
    if (previous?.own && previous.role === role) previous.content = `${previous.content}\n\n${content}`
    else flat.push({ role, content, own: true })
  }
  for (const message of messages) {
    const calls = callsOf(message)
    if (message.role === ASSISTANT && calls.length) {
      for (const call of calls) names.set(call.id, call.function.name)
      add(
        ASSISTANT,
        [
          textOf(message.content).trim(),
          ...calls.map(
            (call) =>
              "```tool\n" +
              JSON.stringify({ name: call.function.name, arguments: parsedOr(call.function.arguments) }) +
              "\n```"
          )
        ]
          .filter(Boolean)
          .join("\n")
      )
    } else if (message.role === "tool") {
      const id = (message as { tool_call_id?: string }).tool_call_id ?? ""
      add(USER, toolResultMessage(names.get(id) ?? "tool", textOf(message.content)))
    } else {
      flat.push({ role: message.role, content: message.content, own: false })
    }
  }
  return flat.map(({ role, content }) => ({ role, content }) as ChatMessage)
}

interface PendingCall {
  raw?: ChatToolCall
  call?: ToolCall
  error?: string
  detail?: string
  written?: string
}

interface ResultSlot {
  message: number
  step: number
  name: string
  trimmed: boolean
  preface?: string
  digest?: string
  after?: string
}

class ToolLoop {
  private _mode: ToolMode
  private _effort: ChatRequest["reasoningEffort"]
  private _messages: ChatMessage[] = []
  private _results: ResultSlot[] = []
  private _shown = ""
  private _record: ({ name: string; args: Record<string, string>; output: string } | { said: string })[] = []
  private _plan?: ContextPlan
  private readonly _estimator = new TokenEstimator()
  private readonly _usage: ToolLoopUsage = {}
  private _flattened = false
  private readonly _answered = new Map<string, { summary: string; slot?: ResultSlot }>()
  private _repeats = 0
  private _unreadable = 0
  private _stuck = false
  private readonly _tools: ToolSpec[]
  private _tasks: Task[] = []
  private readonly _acted: string[] = []

  constructor(
    private readonly _client: InferenceClient,
    private readonly _workspace: WorkspaceTools,
    private readonly _options: ToolLoopOptions
  ) {
    this._mode = _options.mode ?? "text"
    this._effort = _options.reasoningEffort
    this._tools = _options.tasks === false ? _workspace.tools : [..._workspace.tools, TASKS_TOOL]
  }

  async *run(request: ChatRequest, options?: InferenceOptions): AsyncGenerator<ChatChunk> {
    try {
      yield* this.steps(request, options)
    } finally {
      this._options.onNotes?.(this.notes())
      this._options.onEnd?.()
    }
  }

  private prompt(request: ChatRequest) {
    const { orientation, instructions } = this._workspace
    return withToolPrompt(
      request.messages,
      [toolInstructions(this._tools, orientation, this._mode === "native"), ...(instructions ? [instructionsSection(instructions)] : [])].join("\n\n")
    )
  }

  private async compacted(request: ChatRequest, definitionChars: number): Promise<ChatRequest> {
    const plan = await this.plan()
    if (!plan) return request
    const extra = charsOf(this.prompt({ ...request, messages: [] })) + (this._mode === "native" ? definitionChars : 0)
    const { messages, folded } = compactHistory(request.messages, plan, (chars) => this._estimator.tokens(chars + extra))
    if (!folded) return request
    this._options.onCompact?.(folded)
    return { ...request, messages }
  }

  private async plan(): Promise<ContextPlan | undefined> {
    let window: number | undefined
    try {
      window = await this._options.contextWindow?.()
    } catch {
      window = undefined
    }
    this._plan = window && window > 0 ? planContext(window) : undefined
    return this._plan
  }

  private closingPrompt() {
    const open = this._tasks.filter((task) => !task.done)
    return [
      FINAL_ANSWER_PROMPT,
      ...(this._acted.length
        ? [`What you did in this reply, from the record:\n${this._acted.slice(-MAX_LEDGER_LINES).map((line) => `- ${line}`).join("\n")}`]
        : []),
      ...(open.length ? [`Still open on your list:\n${renderTasks(open)}`] : [])
    ].join("\n\n")
  }

  private updateTasks(call: ToolCall): ToolResult {
    const tasks = parseTasks(call.args.tasks ?? Object.values(call.args)[0])
    if (!tasks) {
      return {
        output: "update_tasks needs the list: one step per line, `[ ] step` or `[x] step`.",
        summary: "tasks · no list given",
        failed: true
      }
    }
    const unchanged = sameTasks(tasks, this._tasks)
    if (unchanged) this._repeats++
    this._tasks = tasks
    this._options.onTasks?.(tasks)
    const next = tasks.find((task) => !task.done)
    return {
      output: unchanged
        ? `The list is the same as before. ${next ? `Do the next step now: ${next.text}` : "Every step is done: tell the user what you did."}`
        : next
          ? `Saved (${tasksProgress(tasks)}). Next: ${next.text}`
          : `Saved. All ${tasks.length} steps are done: check your work if you have not, then tell the user what you did.`,
      summary: `tasks · ${tasksProgress(tasks)}`
    }
  }

  private async *steps(request: ChatRequest, options?: InferenceOptions): AsyncGenerator<ChatChunk> {
    const maxSteps = this._options.maxSteps ?? DEFAULT_MAX_STEPS
    const outer = options?.signal
    const definitions = this._tools.map(toolDefinition)
    const definitionChars = JSON.stringify(definitions).length
    request = await this.compacted(request, definitionChars)
    this._messages = this.prompt(request)

    let settled = false
    for (let step = 0; ; step++) {
      if (step > 0) this.steer()
      const last = settled || this._stuck || step >= maxSteps
      const native = this._mode === "native"
      const tools = native && !last ? definitions : undefined
      const closing = last && !settled ? this.closingPrompt() : undefined

      await this.fit((tools ? definitionChars : 0) + (closing?.length ?? 0))
      const sent = closing ? withClosingPrompt(this._messages, closing) : this._messages
      const promptChars = charsOf(sent) + (tools ? definitionChars : 0)
      this._options.onRequest?.(promptChars, step, this._mode, this._estimator.tokens(promptChars))

      const stepAbort = new AbortController()
      const forward = () => stepAbort.abort(outer?.reason)
      if (outer?.aborted) forward()
      else outer?.addEventListener("abort", forward, { once: true })

      const reply = { text: "", shown: 0, toolCalls: undefined as ChatToolCall[] | undefined }
      let found: FoundCall | undefined
      let finishReason: ChatFinishReason | undefined
      let promptTokens: number | undefined
      let completionTokens: number | undefined
      try {
        const chunks = this._client.chat(
          {
            ...request,
            messages: sent,
            ...(this._effort ? { reasoningEffort: this._effort } : {}),
            ...(tools ? { tools } : {})
          },
          { ...options, signal: stepAbort.signal }
        )
        for await (const chunk of chunks) {
          reply.text += chunk.content
          if (chunk.toolCalls) reply.toolCalls = [...(reply.toolCalls ?? []), ...chunk.toolCalls]
          if (chunk.usage?.promptTokens) promptTokens = chunk.usage.promptTokens
          if (chunk.usage?.completionTokens) completionTokens = chunk.usage.completionTokens
          if (chunk.finishReason) finishReason = chunk.finishReason
          if (!last) {
            found = findToolCall(reply.text)
            if (found) break
          }
          const safe = displayableLength(reply.text)
          if (safe > reply.shown) {
            yield this.show(reply.text.slice(reply.shown, safe))
            reply.shown = safe
          }
        }
      } catch (error) {
        if (outer?.aborted) throw error
        if (this._effort && !reply.text && refusesReasoningEffort(error)) {
          this._options.onFallback?.((error as Error).message, "reasoning-effort")
          this._effort = undefined
          step--
          continue
        }
        if (native && !reply.text && mentionsTools(error)) {
          if (!this._results.length) {
            this._options.onFallback?.((error as Error).message, "tools")
            this._mode = "text"
            this._messages = this.prompt(request)
            step--
            continue
          }
          if (last && !this._flattened) {
            this._flattened = true
            this._messages = flattenToolHistory(this._messages)
            this._results = []
            this._answered.clear()
            this._mode = "text"
            step--
            continue
          }
        }
        if (!isCancelled(error)) throw error
      } finally {
        outer?.removeEventListener("abort", forward)
        stepAbort.abort()
      }

      this.count(promptChars, promptTokens, completionTokens)

      const nativeCalls = native && !last ? this.nativeCalls(reply.toolCalls) : []
      if (!nativeCalls.length) found ??= findToolCall(reply.text, true)
      if (!nativeCalls.length && !last) found ??= findFencedCall(reply.text, new Set(this._tools.map((tool) => tool.name)))
      const written = reply.text
      const calls = nativeCalls.length ? nativeCalls : last ? [] : this.textCall(found, reply, step)

      if (!calls.length) {
        if (last && found) {
          const { lead, after } = withoutCalls(written.slice(reply.shown))
          if (lead) yield this.show(lead)
          for (const piece of after) yield this.show(`${gapAfter(this._shown)}${piece}`)
        } else if (written.length > reply.shown) {
          yield this.show(written.slice(reply.shown))
        }
        if (!this._shown.trim() && this._record.length) {
          yield this.show(
            settled
              ? "The change is waiting in the editor for you to accept or reject."
              : this._stuck
                ? "I was going round in circles with the same tool calls, so I stopped there; the steps above show what I tried."
                : last
                  ? "I ran out of tool steps for this reply before I could finish. Continue, and I will carry on from here."
                  : "The model finished without writing a reply; the steps above show what it did."
          )
        }
        if (last && !settled && !this._stuck && step >= maxSteps) this._options.onOutOfSteps?.()
        const usage = this._usage.promptTokens || this._usage.completionTokens ? { ...this._usage } : undefined
        if (usage || finishReason) {
          yield { content: "", ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) }
        }
        return
      }

      const markup = found ?? (nativeCalls.length ? findToolCall(written, true) : undefined)
      const proseEnd = markup ? markup.start : written.length
      if (proseEnd > reply.shown) yield this.show(written.slice(reply.shown, proseEnd))
      const results: ToolResult[] = []
      const keys: (string | undefined)[] = []
      for (const [i, pending] of calls.entries()) {
        const id = `${step}.${i}`
        const name = pending.call?.name ?? pending.raw?.name ?? "unknown"
        this._options.onToolStart?.({ id, name, args: pending.call?.args ?? {} })
        const listing = pending.call?.name === TASKS_TOOL_NAME && this._tools.includes(TASKS_TOOL)
        const key = pending.call && !listing ? this.answerKey(pending.call) : undefined
        if (pending.call && !key && !listing) this._answered.clear()
        const share = this._plan ? Math.max(MIN_RESULT_CHARS, Math.floor(this._plan.resultChars / calls.length)) : undefined
        const earlier = key ? this._answered.get(key) : undefined
        const repeated = earlier && !earlier.slot?.trimmed ? earlier : undefined
        if (repeated) this._repeats++
        const ran: ToolResult = !pending.call
          ? {
              output: unreadableCallMessage(pending, native),
              summary: `tool call not understood · ${pending.error}`,
              failed: true
            }
          : repeated
            ? {
                output:
                  `You already called ${name} with these same arguments in this reply, and nothing in the workspace has changed since, ` +
                  "so it was not run again: its result is above. Use that, or try something different.",
                summary: `${repeated.summary} · repeated, not run again`
              }
            : listing
              ? this.updateTasks(pending.call)
              : await this.runCall(pending.call, outer, share)
        if (pending.call && !repeated && !ran.failed && this._tools.find((tool) => tool.name === name)?.acts) {
          this._acted.push(ran.summary)
        }
        keys.push(repeated || ran.failed ? undefined : key)
        const left = (reply.toolCalls?.length ?? 0) - calls.length
        const note =
          left > 0 && i === calls.length - 1
            ? `\n(${left} more ${left === 1 ? "call" : "calls"} in the same reply ${left === 1 ? "was" : "were"} not run; make ${left === 1 ? "it" : "them"} again if still needed.)`
            : ""
        const { preface } = ran
        const room = share ? Math.max(MIN_RESULT_CHARS, share - (preface?.length ?? 0)) : undefined
        const result: ToolResult = {
          ...ran,
          output: (room ? fitResult(ran.output, room) : ran.output) + note || "(no output)"
        }
        const sent = preface ? { ...result, output: `${preface}\n\n${result.output}` } : result
        results.push(sent)
        this._record.push({ name, args: pending.call?.args ?? {}, output: result.output })
        this._options.onStep?.({
          id,
          index: step,
          mode: this._mode,
          name: pending.call?.name ?? pending.raw?.name,
          args: pending.call?.args,
          parseError: pending.error,
          summary: result.summary,
          output: result.output,
          failed: result.failed,
          promptChars
        })
        if (this._options.stepLines !== false) {
          yield this.show(`${gapAfter(this._shown)}${stepLine(result.summary)}`)
        }
      }
      const slots = this.remember(calls, results, reply.text, found, step)
      keys.forEach((key, i) => {
        if (key) this._answered.set(key, { summary: results[i].summary, slot: slots[i] })
      })
      this._unreadable = calls.every((pending) => !pending.call) ? this._unreadable + 1 : 0
      if (this._repeats >= MAX_REPEATED_CALLS || this._unreadable >= MAX_UNREADABLE_IN_A_ROW) this._stuck = true
      settled = results.some((result) => result.final)
    }
  }

  private answerKey(call: ToolCall): string | undefined {
    if (!this._tools.find((tool) => tool.name === call.name)?.readOnly) return undefined
    const args = Object.entries(call.args)
      .map(([name, value]) => [name, value.trim()])
      .filter(([, value]) => value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return JSON.stringify([call.name, args])
  }

  private steer() {
    const said = (this._options.steering?.() ?? []).map((text) => text.trim()).filter(Boolean)
    if (!said.length) return
    const message = steeringMessage(said)
    const at = this._messages.length - 1
    const final = this._messages[at]
    if (this._mode === "text" && final?.role === USER && typeof final.content === "string") {
      this._messages[at] = { ...final, content: `${final.content}\n\n${message}` }
      const slot = this._results.find((result) => result.message === at)
      if (slot) slot.after = `${slot.after ?? ""}\n\n${message}`
    } else {
      this._messages.push({ role: USER, content: message })
    }
    for (const text of said) this._record.push({ said: text })
  }

  private async runCall(call: ToolCall, signal?: AbortSignal, roomChars?: number): Promise<ToolResult> {
    const work = this._workspace.run(call, { signal, ...(roomChars ? { roomChars } : {}) })
    if (!signal) return work
    work.catch(() => undefined)
    if (signal.aborted) throw cancelled(signal.reason)
    let onAbort = () => undefined as void
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelled(signal.reason))
      signal.addEventListener("abort", onAbort, { once: true })
    })
    stopped.catch(() => undefined)
    try {
      return await Promise.race([work, stopped])
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }

  private count(promptChars: number, promptTokens?: number, completionTokens?: number) {
    this._estimator.observe(promptChars, promptTokens)
    if (!promptTokens && !completionTokens) return
    if (promptTokens) this._usage.promptTokens = Math.max(this._usage.promptTokens ?? 0, promptTokens)
    if (completionTokens) this._usage.completionTokens = (this._usage.completionTokens ?? 0) + completionTokens
    this._options.onUsage?.({ ...this._usage })
  }

  private async fit(extraChars: number) {
    const plan = await this.plan()
    if (!plan) return
    const estimate = () => this._estimator.tokens(charsOf(this._messages) + extraChars)
    if (estimate() <= plan.limit) return
    const newest = this._results.length ? this._results[this._results.length - 1].step : 0
    const passes: Array<(slot: ResultSlot) => boolean> = [
      (slot) => slot.step < newest - 1,
      (slot) => slot.step < newest,
      () => true
    ]
    let trimmed = 0
    for (const eligible of passes) {
      for (const slot of this._results) {
        if (slot.trimmed || !eligible(slot)) continue
        if (estimate() <= plan.target) break
        if (textOf(this._messages[slot.message]?.content).length < MIN_TRIMMABLE_CHARS) continue
        this.trim(slot)
        trimmed++
      }
      if (estimate() <= plan.limit) break
    }
    if (trimmed) this._options.onTrim?.(trimmed, estimate())
  }

  private trim(slot: ResultSlot) {
    const message = this._messages[slot.message]
    if (!message) return
    const whole = textOf(message.content)
    const after = slot.after && whole.endsWith(slot.after) ? slot.after : ""
    const text = whole.slice(0, whole.length - after.length)
    const output = message.role === "tool" ? text : text.replace(/^<tool_result[^>]*>\n/, "").replace(/\n<\/tool_result>$/, "")
    const { preface } = slot
    const kept =
      preface && output.startsWith(preface)
        ? `${preface}\n\n${trimmedResult(output.slice(preface.length).trimStart(), slot.digest)}`
        : trimmedResult(output, slot.digest)
    this._messages[slot.message] = (
      message.role === "tool" ? { ...message, content: kept } : { ...message, content: toolResultMessage(slot.name, kept) + after }
    ) as ChatMessage
    slot.trimmed = true
  }

  private notes(): string | undefined {
    if (!this._record.length) return undefined
    const head = [
      ...(this._tasks.length ? [`Your task list (${tasksProgress(this._tasks)}):\n${renderTasks(this._tasks)}`] : []),
      ...(this._acted.length ? [`What that reply did:\n${this._acted.slice(-MAX_LEDGER_LINES).map((line) => `- ${line}`).join("\n")}`] : [])
    ].join("\n\n")
    const budget = Math.max(600, (this._plan?.notesChars ?? 6000) - head.length)
    const each = Math.max(200, Math.min(1200, Math.floor(budget / this._record.length) - 100))
    const blocks = this._record.map((entry) =>
      "said" in entry
        ? `The user, while you worked: ${clipTo(entry.said, each)}`
        : `${entry.name} ${clipTo(JSON.stringify(entry.args), 240)}\n${clipTo(entry.output, each)}`
    )
    while (blocks.length > 1 && blocks.join("\n\n").length > budget) blocks.shift()
    return [...(head ? [head] : []), clipTo(blocks.join("\n\n"), budget)].join("\n\n")
  }

  private show(content: string): ChatChunk {
    this._shown += content
    return { content }
  }

  private nativeCalls(toolCalls: ChatToolCall[] | undefined): PendingCall[] {
    return (toolCalls ?? []).slice(0, MAX_CALLS_PER_REPLY).map((raw) => {
      const call = parseArguments(raw)
      if ("error" in call) {
        return { raw: { ...raw, arguments: "{}" }, error: call.error, detail: call.detail, written: raw.arguments }
      }
      return { raw: strictJson(raw.arguments) ? raw : { ...raw, arguments: JSON.stringify(call.args) }, call }
    })
  }

  private textCall(found: FoundCall | undefined, reply: { text: string }, step: number): PendingCall[] {
    if (!found) return []
    if (found.call) found.call = nameArguments(found.call, this._tools)
    const unread = found.call ? {} : { detail: found.detail, written: reply.text.slice(found.start, found.end) }
    if (this._mode === "native") {
      reply.text = reply.text.slice(0, found.start).trimEnd()
      const raw = {
        id: `call_text_${step}`,
        name: found.call?.name ?? "unknown",
        arguments: JSON.stringify(found.call?.args ?? {})
      }
      return [{ raw, call: found.call, error: found.error, ...unread }]
    }
    reply.text = reply.text.slice(0, found.end)
    return [{ call: found.call, error: found.error, ...unread }]
  }

  private remember(
    calls: PendingCall[],
    results: ToolResult[],
    text: string,
    found: FoundCall | undefined,
    step: number
  ): ResultSlot[] {
    const slot = (name: string, result: ToolResult): ResultSlot => ({
      message: this._messages.length,
      step,
      name,
      trimmed: false,
      ...(result.preface ? { preface: result.preface } : {}),
      ...(result.digest ? { digest: result.digest } : {})
    })
    const slots: ResultSlot[] = []
    if (this._mode === "native") {
      this._messages.push({
        role: ASSISTANT,
        content: text.trim() ? text : null,
        tool_calls: calls.map(({ raw }) => ({
          id: raw!.id,
          type: "function" as const,
          function: { name: raw!.name, arguments: raw!.arguments }
        }))
      } as ChatMessage)
      calls.forEach(({ raw }, i) => {
        slots.push(slot(raw!.name, results[i]))
        this._messages.push({ role: "tool", tool_call_id: raw!.id, content: results[i].output } as ChatMessage)
      })
      this._results.push(...slots)
      return slots
    }
    const name = calls[0].call?.name ?? "error"
    this._messages.push({ role: ASSISTANT, content: found?.unclosed ? `${text.trimEnd()}\n${found.unclosed}` : text })
    slots.push(slot(name, results[0]))
    this._results.push(...slots)
    this._messages.push({ role: USER, content: toolResultMessage(name, results[0].output) })
    return slots
  }
}

export const withTools = (
  client: InferenceClient,
  workspace: WorkspaceTools,
  options: ToolLoopOptions = {}
): InferenceClient => ({
  id: client.id,
  capabilities: () => client.capabilities(),
  models: (o) => client.models(o),
  fim: (request, o) => client.fim(request, o),
  embeddings: (request, o) => client.embeddings(request, o),
  chat: (request, o) => new ToolLoop(client, workspace, options).run(request, o)
})
