import { Disposable, Webview } from "vscode"

import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"
import { Envelope, isEnvelope } from "../../common/messaging/envelope"
import {
  ClientEventName,
  PayloadOf,
  ReplyOf,
  ServerEventName,
  ServerPayloadOf
} from "../../common/messaging/protocol"

export type Handler<K extends ClientEventName> = (
  payload: PayloadOf<K>
) => ReplyOf<K> | Promise<ReplyOf<K>> | void | Promise<void>

type ErasedHandler = (payload: never) => unknown

export class ExtensionBridge implements Disposable {
  private readonly _handlers = new Map<string, ErasedHandler>()
  private readonly _subscription: Disposable
  private _disposed = false

  constructor(private readonly _webview: Webview) {
    this._subscription = _webview.onDidReceiveMessage((message: unknown) => {
      void this._dispatch(message)
    })
  }

  public handle<K extends ClientEventName>(type: K, handler: Handler<K>): this {
    if (this._handlers.has(type)) {
      logger.error(new Error(`Duplicate handler registered for "${type}"`))
    }
    this._handlers.set(type, handler as ErasedHandler)
    return this
  }

  public handleAll(handlers: {
    [K in ClientEventName]?: Handler<K>
  }): this {
    for (const [type, handler] of Object.entries(handlers)) {
      if (handler) this.handle(type as ClientEventName, handler as never)
    }
    return this
  }

  public emit<K extends ServerEventName>(
    type: K,
    data?: ServerPayloadOf<K>
  ): void {
    if (this._disposed) return
    void this._webview.postMessage({ type, data } satisfies Envelope)
  }

  public dispose(): void {
    this._disposed = true
    this._handlers.clear()
    this._subscription.dispose()
  }

  private async _dispatch(message: unknown): Promise<void> {
    if (!isEnvelope(message)) return

    const handler = this._handlers.get(message.type)
    if (!handler) return

    const { id, type } = message

    try {
      const result = await handler(message.data as never)
      if (result === undefined) return
      void this._webview.postMessage(
        id ? { type, id, data: result } : { type, data: result }
      )
    } catch (error) {
      const reason = messageOf(error)
      logger.error(new Error(`Handler for "${type}" failed: ${reason}`))
      if (id) void this._webview.postMessage({ type, id, error: reason })
    }
  }
}
