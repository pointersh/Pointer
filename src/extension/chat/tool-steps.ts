import { ToolStepView } from "../../common/types"

export interface ToolStep {
  id: string
  index: number
  name?: string
  args?: Record<string, string>
  summary: string
  output: string
  failed?: boolean
}

export interface ToolStart {
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
  private readonly _stoppers = new Map<string, () => void>()
  private readonly _stopped = new Set<string>()
  private _live: { id: string; output: string } | undefined
  private _liveTimer: ReturnType<typeof setTimeout> | undefined
  private _muted = false

  constructor(private readonly _emit: (steps: ToolStepView[]) => void) {}

  public reset() {
    this.cancelWaiting()
    this._muted = false
    this._steps = []
    this._skipped.clear()
    this._stoppers.clear()
    this._stopped.clear()
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
    this._stoppers.delete(step.id)
    const status = this._skipped.has(step.id)
      ? "skipped"
      : this._stopped.has(step.id)
        ? "stopped"
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
      mcpTool: undefined,
      stoppable: undefined
    })
  }

  public said(id: string, text: string) {
    this._steps = [...this._steps, { id: `said.${id}`, name: "said", summary: text, status: "done", said: true }]
    this.send()
  }

  public stoppable(stop: () => void) {
    const step = [...this._steps].reverse().find((s) => s.status === "running")
    if (!step) return
    this._stoppers.set(step.id, stop)
    this.update(step.id, { stoppable: true })
  }

  public stop(id: string) {
    const stop = this._stoppers.get(id)
    if (!stop) return
    this._stoppers.delete(id)
    this._stopped.add(id)
    this.update(id, { stoppable: undefined })
    stop()
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
    options: { always?: boolean; mcpTool?: string } = {}
  ): Promise<boolean> {
    const step = [...this._steps].reverse().find((s) => s.status === "running")
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
        ? { ...step, status: "stopped" as const, command: undefined, approval: undefined, stoppable: undefined }
        : step
    )
    this.send()
  }

  private update(id: string, change: Partial<ToolStepView>) {
    this._steps = this._steps.map((step) => (step.id === id ? { ...step, ...change } : step))
    this.send()
  }

  public discard() {
    this.cancelWaiting()
    this._muted = true
    this._steps = []
  }

  private send() {
    if (!this._muted) this._emit(this._steps)
  }
}
