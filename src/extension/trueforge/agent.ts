import { ASSISTANT, EVENT_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import { ChatCompletionMessage, MentionType, ReplyMeta } from "../../common/types"
import { Agent } from "../agent"
import { ToolSteps } from "../chat/tool-steps"
import { GenerationRun, GenerationTracker } from "../generations"
import { ExtensionBridge } from "../messaging/bridge"

import { AGENT_MANIFEST, AGENT_NAME, agentManifest, describeError, modelChain } from "./client"
import { cancelSession, createSession, runTurn, TurnResult } from "./session"

const WRITE_TOOL = /^(edit_file|create_file|delete_file|move_file|rename_symbol|run_command)$/

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
    const run = this._generations.start("chat")
    this._run = run
    this._discarded = false
    this._steps.reset()
    const started = Date.now()
    const chain = modelChain()
    let result: TurnResult | undefined
    let failure: string | undefined

    try {
      while (this._model < chain.length) {
        try {
          this._sessionId ??= await this.openSession(chain, history)
          result = await runTurn(
            this._sessionId,
            input,
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
          result = { status: "error", text: "", error: describeError(error) }
        }
        if (result.status !== "error" || run.signal.aborted) break
        failure = result.error
        logger.warn(`TrueForge turn failed on ${chain[this._model]}: ${failure}`)
        if (/reach TrueForge/.test(failure ?? "")) break
        this._model++
        this._sessionId = undefined
        if (this._model < chain.length) {
          this._bridge.emit(EVENT_NAME.pointerOnCompletion, {
            role: ASSISTANT,
            content: `_${chain[this._model - 1]} failed; retrying on ${chain[this._model]}…_`
          })
        }
      }
    } finally {
      this._steps.settle()
      run.finish()
      if (this._run === run) this._run = undefined
    }

    if (this._discarded) return
    const meta: ReplyMeta = {
      model: result?.model ?? chain[Math.min(this._model, chain.length - 1)],
      provider: "TrueForge",
      durationMs: Date.now() - started,
      promptTokens: result?.promptTokens,
      completionTokens: result?.completionTokens,
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

  private openSession(chain: string[], history: ChatCompletionMessage[]) {
    if (this._model === 0 && chain[0] === AGENT_MANIFEST.model.name) return createSession({ name: AGENT_NAME })
    const earlier = transcript(history)
    return createSession({
      spec: {
        ...agentManifest(),
        model: { name: chain[this._model] },
        ...(earlier ? { messages: [{ type: "user.message", content: `Conversation so far:\n\n${earlier}` }] } : {})
      }
    })
  }

  private approve(callId: string) {
    const step = this._steps.steps.find((s) => s.id === callId)
    const kind = step && step.name === "run_command" ? "command" : "change"
    const detail = step?.args?.command ?? step?.args?.path ?? step?.name ?? "this action"
    return this._steps.approve(detail, step && WRITE_TOOL.test(step.name) ? kind : "command", { always: false })
  }

  public abort() {
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
    this._sessionId = undefined
    this._model = 0
    this._steps.reset()
  }

  public answerToolApproval(id: string, run: boolean) {
    this._steps.answer(id, run)
  }

  public stopToolStep(id: string) {
    this._steps.stop(id)
  }

}
