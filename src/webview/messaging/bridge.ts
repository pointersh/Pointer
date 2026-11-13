import { Envelope, isEnvelope } from "../../common/messaging/envelope"
import {
  ClientEventName,
  PayloadOf,
  ReplyOf,
  RequestableEvent,
  ServerEventName,
  ServerPayloadOf,
  VoidPayloadEvent
} from "../../common/messaging/protocol"

export type Unsubscribe = () => void

type Listener = (data: unknown) => void

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 30_000

class WebviewBridge {
  private readonly _listeners = new Map<string, Set<Listener>>()
  private readonly _pending = new Map<string, Pending>()
  private _nextId = 0
  private readonly _vscode = acquireVsCodeApi()

  constructor() {
    window.addEventListener("message", this._receive)
  }

  public emit<K extends VoidPayloadEvent>(type: K): void
  public emit<K extends ClientEventName>(type: K, payload: PayloadOf<K>): void
  public emit(type: string, payload?: unknown): void {
    this._vscode.postMessage({ type, data: payload } satisfies Envelope)
  }

  public request<K extends RequestableEvent & VoidPayloadEvent>(
    type: K
  ): Promise<ReplyOf<K>>
  public request<K extends RequestableEvent>(
    type: K,
    payload: PayloadOf<K>
  ): Promise<ReplyOf<K>>
  public request(type: string, payload?: unknown): Promise<unknown> {
    const id = `${type}:${this._nextId++}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`Timed out waiting for a reply to "${type}"`))
      }, REQUEST_TIMEOUT_MS)

      this._pending.set(id, { resolve, reject, timer })
      this._vscode.postMessage({ type, id, data: payload } satisfies Envelope)
    })
  }

  public on<K extends ServerEventName>(
    type: K,
    listener: (data: ServerPayloadOf<K>) => void
  ): Unsubscribe {
    const listeners = this._listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener as Listener)
    this._listeners.set(type, listeners)

    return () => {
      listeners.delete(listener as Listener)
      if (listeners.size === 0) this._listeners.delete(type)
    }
  }

  private _receive = (event: MessageEvent): void => {
    const message: unknown = event.data
    if (!isEnvelope(message)) return

    if (message.id) {
      const pending = this._pending.get(message.id)
      if (pending) {
        this._pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve(message.data)
        return
      }
    }

    this._listeners.get(message.type)?.forEach((listener) => {
      listener(message.data)
    })
  }
}

export const bridge = new WebviewBridge()
