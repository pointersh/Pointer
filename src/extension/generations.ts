type GenerationKind = "chat" | "edit" | "completion"

export interface GenerationRun {
  readonly kind: GenerationKind
  readonly signal: AbortSignal
  abort(reason?: unknown): void
  finish(): void
}

interface GenerationState {
  busy: boolean
  stoppable: boolean
}

type Listener<T> = (value: T) => void

const IDLE: GenerationState = { busy: false, stoppable: false }

export class GenerationTracker {
  private readonly _live = new Set<GenerationRun>()
  private readonly _changed = new Set<Listener<GenerationState>>()
  private readonly _stopped = new Set<Listener<void>>()
  private _state = IDLE

  public get state(): GenerationState {
    return this._state
  }

  public start(kind: GenerationKind): GenerationRun {
    const controller = new AbortController()
    let live = true
    const run: GenerationRun = {
      kind,
      signal: controller.signal,
      abort: (reason) => {
        controller.abort(reason)
        run.finish()
      },
      finish: () => {
        if (!live) return
        live = false
        this._live.delete(run)
        this.update()
      }
    }
    this._live.add(run)
    this.update()
    return run
  }

  public stopAll() {
    for (const run of [...this._live]) run.abort()
    for (const listener of [...this._stopped]) listener()
  }

  public onDidChange(listener: Listener<GenerationState>) {
    return this.subscribe(this._changed, listener)
  }

  public onDidStop(listener: Listener<void>) {
    return this.subscribe(this._stopped, listener)
  }

  private subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>) {
    listeners.add(listener)
    return { dispose: () => listeners.delete(listener) }
  }

  private update() {
    const runs = [...this._live]
    const next: GenerationState = {
      busy: runs.length > 0,
      stoppable: runs.some((run) => run.kind !== "completion")
    }
    if (next.busy === this._state.busy && next.stoppable === this._state.stoppable) {
      return
    }
    this._state = next
    for (const listener of [...this._changed]) listener(next)
  }
}
