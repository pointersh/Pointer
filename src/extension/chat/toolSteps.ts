import { ToolStepView } from "../../common/types"

interface ToolStep {
  id: string
  index: number
  name?: string
  args?: Record<string, string>
  summary: string
  output: string
  failed?: boolean
}

interface ToolStart {
  id: string
  name: string
  args: Record<string, string>
}

const MAX_SHOWN_OUTPUT = 4000
const MAX_SHOWN_ARG = 2000
const MAX_ARG_IN_SUMMARY = 80
const MAX_LIVE_OUTPUT = 2000
const LIVE_EVERY_MS = 250

const shown = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text

const shownArgs = (args: Record<string, string>) =>
  Object.fromEntries(Object.entries(args).map(([name, value]) => [name, shown(value, MAX_SHOWN_ARG)]))

const firstArg = (args: Record<string, string>) => {
  const value = Object.values(args).find((v) => v.trim())?.trim() ?? ""
  const line = value.split("\n")[0]
  return line.length > MAX_ARG_IN_SUMMARY ? `${line.slice(0, MAX_ARG_IN_SUMMARY)}…` : line
}

const startSummary = ({ name, args }: ToolStart) => {
  const what = firstArg(args)
  return what ? `${name} \`${what}\`` : name
}

export class ToolSteps {
  private _steps: ToolStepView[] = []
  private readonly _waiting = new Map<string, (run: boolean) => void>()
  private readonly _skipped = new Set<string>()
  private _live: { id: string; output: string } | undefined
  private _liveTimer: ReturnType<typeof setTimeout> | undefined
  private _muted = false

  constructor(private readonly _emit: (steps: ToolStepView[]) => void) {}

  public reset() {
    clearTimeout(this._sendTimer)
    this._sendTimer = undefined
    this.cancelWaiting()
    this._muted = false
    this._steps = []
    this._skipped.clear()
    clearTimeout(this._liveTimer)
    this._liveTimer = undefined
    this._live = undefined
  }

  public get steps(): ToolStepView[] {
    return this._steps
  }

  public start(start: ToolStart) {
    this._steps = [
      ...this._steps,
      { id: start.id, name: start.name, args: shownArgs(start.args), summary: startSummary(start), status: "running" }
    ]
    this.send()
  }

  public finish(step: ToolStep) {
    const output = shown(step.output, MAX_SHOWN_OUTPUT)
    const status = this._skipped.has(step.id)
      ? "skipped"
      : step.failed
        ? "failed"
        : "done"
    this.update(step.id, {
      summary: step.summary,
      output,
      status,
      command: undefined,
      approval: undefined,
      noAlways: undefined,
      mcpTool: undefined
    })
  }

  public said(id: string, text: string) {
    this._steps = [...this._steps, { id: `said.${id}`, name: "said", summary: text, status: "done", said: true }]
    this.send()
  }

  public progress(output: string) {
    const step = [...this._steps].reverse().find((s) => s.status === "running")
    if (!step) return
    this._live = { id: step.id, output: output.slice(-MAX_LIVE_OUTPUT) }
    if (this._liveTimer) return
    this._liveTimer = setTimeout(() => {
      this._liveTimer = undefined
      const live = this._live
      if (!live || !this._steps.some((s) => s.id === live.id && s.status === "running")) return
      this.update(live.id, { output: live.output })
    }, LIVE_EVERY_MS)
  }

  public approve(
    detail: string,
    approval: "command" | "change" = "command",
    options: { always?: boolean; mcpTool?: string; id?: string } = {}
  ): Promise<boolean> {
    const step = this._steps.find((s) => s.id === options.id) ?? [...this._steps].reverse().find((s) => s.status === "running")
    if (!step) return Promise.resolve(false)
    this.update(step.id, {
      status: "waiting",
      command: detail,
      approval,
      ...(approval === "command" && options.always === false ? { noAlways: true } : {}),
      ...(options.mcpTool ? { mcpTool: options.mcpTool } : {})
    })
    return new Promise((resolve) => {
      this._waiting.set(step.id, (run) => {
        if (!run) this._skipped.add(step.id)
        resolve(run)
      })
    })
  }

  public answer(id: string, run: boolean) {
    const resolve = this._waiting.get(id)
    if (!resolve) return
    this._waiting.delete(id)
    this.update(id, { status: "running", command: undefined, approval: undefined, noAlways: undefined, mcpTool: undefined })
    resolve(run)
  }

  public cancelWaiting() {
    for (const id of [...this._waiting.keys()]) this.answer(id, false)
  }

  public settle() {
    this.cancelWaiting()
    if (!this._steps.some((step) => step.status === "running" || step.status === "waiting")) return
    this._steps = this._steps.map((step) =>
      step.status === "running" || step.status === "waiting"
        ? { ...step, status: "stopped" as const, command: undefined, approval: undefined }
        : step
    )
    this.send(true)
  }

  private update(id: string, change: Partial<ToolStepView>) {
    this._steps = this._steps.map((step) => (step.id === id ? { ...step, ...change } : step))
    // An approval card must not wait for the next tick.
    this.send(change.status === "waiting")
  }

  public discard() {
    this.cancelWaiting()
    this._muted = true
    this._steps = []
  }

  // Every change resends the whole step list; at most one update per 50 ms, approvals and resets at once.
  private _sendTimer: ReturnType<typeof setTimeout> | undefined
  private send(now = false) {
    if (this._muted) return
    if (now) {
      clearTimeout(this._sendTimer)
      this._sendTimer = undefined
      this._emit(this._steps)
      return
    }
    this._sendTimer ??= setTimeout(() => {
      this._sendTimer = undefined
      if (!this._muted) this._emit(this._steps)
    }, 50)
  }
}
