import { ASSISTANT, EVENT_NAME } from "../../common/constants"
import { formatCount, logger } from "../../common/logger"
import { ChatCompletionMessage, ReplyChangesView, ReplyMeta, PointerProvider } from "../../common/types"
import { GenerationRun, GenerationTracker } from "../generations"
import { ChatRequest, InferenceClient, isCancelled } from "../inference"
import { ExtensionBridge } from "../messaging/bridge"
import { describeProviderError, describeProviderErrorPlain, isAbortError } from "../providers/errors"

const contentText = (content: ChatCompletionMessage["content"]): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part.type === "text" ? part.text : `[${part.type}]`
    )
    .join("\n")
}

const contentLength = (content: ChatCompletionMessage["content"]) =>
  contentText(content).length

export interface ReplyExtras {
  toolNotes?(): string | undefined
  meta?(): Partial<ReplyMeta>
  keepEmpty?(): boolean
  settle?(): Promise<void>
  changes?(): ReplyChangesView | undefined
}

export class ChatGeneration {
  private _run?: GenerationRun
  private _cancelled = false
  private readonly _discarded = new WeakSet<GenerationRun>()
  private readonly _stopSubscription: { dispose(): void }

  constructor(
    private readonly _bridge: ExtensionBridge,
    private readonly _generations: GenerationTracker
  ) {
    this._stopSubscription = _generations.onDidStop(() => this.abort())
  }

  public dispose() {
    this._stopSubscription.dispose()
  }

  public get cancelled() {
    return this._cancelled
  }

  public reset() {
    this._cancelled = false
  }

  public abort() {
    this._cancelled = true
    this._run?.abort()
    this._bridge.emit(EVENT_NAME.pointerStopGeneration)
  }

  public get running(): boolean {
    return !!this._run
  }

  public discard() {
    if (this._run) this._discarded.add(this._run)
    this.abort()
  }

  public async generate(
    inference: InferenceClient,
    request: ChatRequest,
    provider: PointerProvider,
    prefix = "",
    extras: ReplyExtras = {}
  ): Promise<string> {
    if (this._cancelled) return ""
    const run = this._generations.start("chat")
    this._run = run
    let text = prefix
    const elapsed = this.logRequest(request.messages, provider)
    const started = Date.now()
    const meta: ReplyMeta = { model: provider.modelName, provider: provider.label }
    const finish = (): ReplyMeta => ({
      ...meta,
      ...extras.meta?.(),
      durationMs: Date.now() - started,
      ...(this._cancelled ? { stopped: true } : {})
    })

    try {
      const chunks = inference.chat(request, {
        signal: run.signal,
        onShield: (report) => {
          meta.withheld = report
        }
      })
      try {
        for await (const chunk of chunks) {
          if (chunk.usage?.completionTokens) {
            meta.completionTokens = chunk.usage.completionTokens
          }
          if (chunk.usage?.promptTokens) {
            meta.promptTokens = chunk.usage.promptTokens
          }
          text += chunk.content
          this._bridge.emit(EVENT_NAME.pointerOnCompletion, {
            content: text.trimStart() || " ",
            role: ASSISTANT
          })
        }
      } catch (error) {
        if (!isCancelled(error)) throw error
      }

      const reply = text.trim()
      logger.info(
        `Chat ← ${elapsed()} · ${formatCount(reply.length)} chars` +
          (run.signal.aborted ? " · stopped by the user" : "")
      )
      logger.block("Chat reply", reply)
      await extras.settle?.()
      if (this._discarded.has(run)) return ""
      if (reply || extras.keepEmpty?.()) this.addMessage(reply, finish(), extras.toolNotes?.(), extras.changes?.())
      return reply
    } catch (error) {
      run.abort()
      const partial = text.trim() === prefix.trim() ? "" : text.trim()
      if (this._discarded.has(run)) return ""
      await extras.settle?.().catch(() => undefined)
      if (partial || extras.keepEmpty?.()) this.addMessage(partial, finish(), extras.toolNotes?.(), extras.changes?.())
      this.report(error, provider)
      return partial
    } finally {
      run.finish()
      if (this._run === run) this._run = undefined
      this._bridge.emit(EVENT_NAME.pointerStopGeneration)
    }
  }

  private addMessage(content: string, meta?: ReplyMeta, toolNotes?: string, changes?: ReplyChangesView) {
    this._bridge.emit(EVENT_NAME.pointerAddMessage, {
      content,
      role: ASSISTANT,
      ...(meta ? { meta } : {}),
      ...(toolNotes ? { toolNotes } : {}),
      ...(changes ? { changes } : {})
    })
  }

  private logRequest(
    messages: ChatCompletionMessage[],
    provider: PointerProvider
  ) {
    const chars = messages.reduce((sum, m) => sum + contentLength(m.content), 0)
    logger.info(
      `Chat → ${provider.modelName} (${provider.label}) · ` +
        `${messages.length} message${messages.length === 1 ? "" : "s"}, ` +
        `${formatCount(chars)} chars`
    )
    logger.block(
      "Chat messages",
      messages
        .map((m) => `[${m.role}]\n${contentText(m.content)}`)
        .join("\n\n")
    )
    return logger.timer()
  }

  private report(error: unknown, provider: PointerProvider) {
    if (isAbortError(error) || this._cancelled) return
    logger.error(`Chat failed: ${describeProviderErrorPlain(error, provider)}`)
    this.addMessage(describeProviderError(error, provider))
  }
}
