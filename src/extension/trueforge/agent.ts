import { ASSISTANT, EVENT_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import { ChatCompletionMessage, MentionType, ReplyMeta } from "../../common/types"
import { Agent } from "../agent"
import { clearGrants, grantTool } from "../chat/approvals"
import { ToolSteps } from "../chat/toolSteps"
import { GenerationRun, GenerationTracker } from "../generations"
import { ExtensionBridge } from "../messaging/bridge"

import { agentManifest, agentReady, describeError, modelChain, modelSpec } from "./client"
import { prefetchContext } from "./prefetch"
import { cancelSession, createSession, pause, RATE_LIMIT_RETRIES, RATE_LIMITED, retryDelay, runTurn, TurnResult } from "./session"

// ponytail: fixed 60 s before retrying the primary; a real circuit breaker with probes if this flaps.
const SURVEY_REQUEST = /\b(tests?|tested|covered by a test|docs?|documented|documentation)\b/i
const SURVEY_HINT =
  "This request touches code, tests and docs: start with create_sub_agent for the survey (where the closest existing example is implemented, tested and documented, as path:line findings)."
const PRIMARY_RETRY_MS = 60_000
const PREFETCH_STEP = "pointer-prefetch"

const plainText = (html: string) =>
  html
    .replace(/<br\s*\/?>|<\/p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim()

const withMentions = (text: string, mentions: MentionType[] = []) => {
  const paths = [...new Set(mentions.map((m) => m.path).filter(Boolean))]
  return paths.length ? `${text}\n\nThe user referenced: ${paths.map((p) => `@${p}`).join(", ")}. Read them first.` : text
}

const transcript = (messages: ChatCompletionMessage[]) =>
  messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${plainText(String(m.content ?? ""))}`)
    .join("\n\n")

export class TrueForgeAgent implements Agent {
  private _sessionId: string | undefined
  private _model = 0
  private _fellBackAt = 0
  private _head: string | undefined
  private _sessionModel: string | undefined
  private _run: GenerationRun | undefined
  private _discarded = false
  private readonly _steps: ToolSteps

  constructor(
    private readonly _bridge: ExtensionBridge,
    private readonly _generations: GenerationTracker
  ) {
    this._steps = new ToolSteps((steps) => _bridge.emit(EVENT_NAME.pointerToolSteps, steps))
  }

  public get replying() {
    return !!this._run
  }

  public async completion(messages: ChatCompletionMessage[], mentions?: MentionType[]) {
    const last = [...messages].reverse().find((m) => m.role === "user")
    if (!last) return
    const input = withMentions(plainText(String(last.content ?? "")), mentions)
    const history = messages.slice(0, messages.lastIndexOf(last))
    // A previous reply still winding down (after Stop or New chat) must not touch this one's steps or UI,
    // and its turn must be stopped before this one starts in the same session.
    if (this._run) {
      this._run.abort()
      if (this._sessionId) await cancelSession(this._sessionId)
    }
    const run = this._generations.start("chat")
    this._run = run
    this._discarded = false
    this._steps.reset()
    const started = Date.now()
    const chain = modelChain()
    if (chain[0] !== this._head) {
      this._head = chain[0]
      this._model = 0
    }
    if (this._model >= chain.length || (this._model > 0 && Date.now() - this._fellBackAt > PRIMARY_RETRY_MS)) this._model = 0
    let result: TurnResult | undefined
    let failure: string | undefined
    let rateLimitRetries = 0

    // Setup failure (TrueForge unreachable at activation) ends the request; a failed turn below falls back instead.
    let unready = false
    try {
      await agentReady()
    } catch (error) {
      failure = describeError(error)
      unready = true
    }

    // Automatic retrieval: shown as the Pointing-at cards and handed to the model with the request.
    let turnInput = input
    if (!unready) {
      // A follow-up ("which files would that touch?") means little alone: search with the request before it too.
      const previous = [...history].reverse().find((m) => m.role === "user")
      const query = [previous, last].filter(Boolean).map((m) => plainText(String(m!.content ?? ""))).join("\n")
      const context = await prefetchContext(query, run.signal)
      if (context && !run.signal.aborted) {
        this._steps.start({ id: PREFETCH_STEP, name: "search_codebase", args: { query: "(automatic) this request" } })
        this._steps.finish({ id: PREFETCH_STEP, index: 0, summary: context.split("\n")[0]?.slice(0, 120) ?? "", output: context })
        turnInput = `${input}\n\nPointer already searched the codebase for this request (BM25, symbols, repo map; reasons per chunk). Start from these, and search again if they are not enough:\n\n${context}`
      }
      // Code plus tests plus docs: the survey of existing examples goes to a TrueForge sub-agent first.
      if (SURVEY_REQUEST.test(plainText(String(last.content ?? "")))) turnInput += `\n\n${SURVEY_HINT}`
    }

    try {
      while (!unready && this._model < chain.length) {
        try {
          if (this._sessionModel !== chain[this._model]) this._sessionId = undefined
          this._sessionId ??= await this.openSession(chain, history)
          result = await runTurn(
            this._sessionId,
            turnInput,
            {
              withThinking: true,
              onText: (text) => this._bridge.emit(EVENT_NAME.pointerOnCompletion, { role: ASSISTANT, content: text || " " }),
              onToolCall: ({ id, name, args }) => this._steps.start({ id, name, args }),
              onToolResult: (id, output) =>
                this._steps.finish({ id, index: 0, summary: output.split("\n")[0]?.slice(0, 120) ?? "", output }),
              onApproval: (id) => this.approve(id)
            },
            run.signal
          )
        } catch (error) {
          result = run.signal.aborted ? { status: "cancelled", text: "" } : { status: "error", text: "", error: describeError(error) }
        }
        if (result.status !== "error" || run.signal.aborted) break
        failure = result.error
        logger.warn(`TrueForge turn failed on ${chain[this._model]}: ${failure}`)
        if (/reach TrueForge/.test(failure ?? "")) break
        // The failed turn may still be running server-side; stop it before another model takes the task.
        if (this._sessionId) void cancelSession(this._sessionId)
        this._sessionId = undefined
        if (RATE_LIMITED.test(failure ?? "") && rateLimitRetries < RATE_LIMIT_RETRIES) {
          const seconds = retryDelay(failure ?? "", rateLimitRetries++)
          this._bridge.emit(EVENT_NAME.pointerOnCompletion, {
            role: ASSISTANT,
            content: `_${chain[this._model]} is rate-limited; retrying in ${seconds}s…_`
          })
          await pause(seconds * 1000, run.signal)
          if (run.signal.aborted) break
          continue
        }
        this._model++
        this._fellBackAt = Date.now()
        rateLimitRetries = 0
        if (this._model < chain.length) {
          this._bridge.emit(EVENT_NAME.pointerOnCompletion, {
            role: ASSISTANT,
            content: `_${chain[this._model - 1]} failed; retrying on ${chain[this._model]}…_`
          })
        }
      }
    } finally {
      run.finish()
    }
    if (this._run !== run) return
    this._run = undefined
    this._steps.settle()
    clearGrants()

    if (this._discarded) return
    const meta: ReplyMeta = {
      model: result?.model ?? chain[Math.min(this._model, chain.length - 1)],
      provider: "TrueForge",
      durationMs: Date.now() - started,
      promptTokens: result?.promptTokens,
      completionTokens: result?.completionTokens,
      modelCalls: result?.modelCalls,
      ...(result?.status === "cancelled" ? { stopped: true } : {})
    }
    const content =
      result?.status === "error" || !result
        ? `**Pointer could not finish.** ${failure ?? result?.error ?? "Unknown error."}`
        : result.text.trim()
    this._bridge.emit(EVENT_NAME.pointerAddMessage, { role: ASSISTANT, content, meta, toolSteps: this._steps.steps })
    this._bridge.emit(EVENT_NAME.pointerStopGeneration)
    if (this._model >= chain.length) this._model = 0
  }

  // Always an inline spec: it names this window's MCP servers, which a shared registered agent can't.
  private openSession(chain: string[], history: ChatCompletionMessage[]) {
    this._sessionModel = chain[this._model]
    const earlier = transcript(history)
    return createSession({
      spec: {
        ...agentManifest(),
        model: modelSpec(chain[this._model]),
        ...(earlier ? { messages: [{ type: "user.message", content: `Conversation so far:\n\n${earlier}` }] } : {})
      }
    })
  }

  private async approve(callId: string) {
    const step = this._steps.steps.find((s) => s.id === callId)
    const kind = !step || step.name === "run_command" ? "command" : "change"
    const args = step?.args ?? {}
    const detail =
      step?.name === "move_file"
        ? `${args.from} → ${args.to}`
        : step?.name === "rename_symbol"
          ? `${args.symbol} → ${args.new_name} in ${args.path}`
          : (args.command ?? args.path ?? step?.name ?? "this action")
    const allowed = await this._steps.approve(detail, kind, { always: false, id: callId })
    if (allowed && step) grantTool(step.name)
    return allowed
  }

  public abort() {
    clearGrants()
    this._run?.abort()
    if (this._sessionId) void cancelSession(this._sessionId)
    this._steps.settle()
    this._bridge.emit(EVENT_NAME.pointerStopGeneration)
  }

  public discardReply() {
    this._discarded = true
    this._steps.discard()
    this.abort()
  }

  public resetConversation() {
    this.abort()
    this._run = undefined
    this._sessionId = undefined
    this._model = 0
    this._steps.reset()
  }

  public answerToolApproval(id: string, run: boolean) {
    this._steps.answer(id, run)
  }

}
