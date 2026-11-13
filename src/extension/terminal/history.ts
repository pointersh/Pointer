import { Disposable, Terminal, TerminalShellExecution, window } from "vscode"

import { logger } from "../../common/logger"

import { runFailed, stripAnsi, TerminalRun } from "./output"

const RUNS_PER_TERMINAL = 5
const MAX_CAPTURE_CHARS = 200_000

export class TerminalHistory implements Disposable {
  private readonly _runs = new Map<Terminal, TerminalRun[]>()
  private readonly _active = new Map<TerminalShellExecution, { output: string }>()
  private readonly _disposables: Disposable[] = []

  constructor() {
    this._disposables.push(
      window.onDidStartTerminalShellExecution((event) => {
        const capture = { output: "" }
        this._active.set(event.execution, capture)
        void this.capture(event.execution, capture)
      }),
      window.onDidEndTerminalShellExecution((event) => {
        const capture = this._active.get(event.execution)
        this._active.delete(event.execution)
        const run: TerminalRun = {
          commandLine: event.execution.commandLine.value,
          output: stripAnsi(capture?.output ?? ""),
          exitCode: event.exitCode,
          cwd: event.execution.cwd?.fsPath,
          terminal: event.terminal.name,
          finishedAt: Date.now()
        }
        const runs = this._runs.get(event.terminal) ?? []
        runs.push(run)
        if (runs.length > RUNS_PER_TERMINAL) runs.shift()
        this._runs.set(event.terminal, runs)
      }),
      window.onDidCloseTerminal((terminal) => this._runs.delete(terminal))
    )
  }

  public get hasRuns(): boolean {
    return this._runs.size > 0
  }

  public last(): TerminalRun | undefined {
    const active = window.activeTerminal
    const fromActive = active && this._runs.get(active)?.at(-1)
    if (fromActive) return fromActive
    return this.all().at(-1)
  }

  public lastFailed(): TerminalRun | undefined {
    const active = window.activeTerminal
    const fromActive = active && this._runs.get(active)?.filter(runFailed).at(-1)
    if (fromActive) return fromActive
    return this.all().filter(runFailed).at(-1)
  }

  public dispose() {
    Disposable.from(...this._disposables).dispose()
  }

  private all(): TerminalRun[] {
    return [...this._runs.values()]
      .flat()
      .sort((a, b) => a.finishedAt - b.finishedAt)
  }

  private async capture(
    execution: TerminalShellExecution,
    capture: { output: string }
  ) {
    try {
      for await (const chunk of execution.read()) {
        capture.output += chunk
        if (capture.output.length > MAX_CAPTURE_CHARS) {
          capture.output = capture.output.slice(-MAX_CAPTURE_CHARS)
        }
      }
    } catch (error) {
      logger.error(`Terminal capture failed: ${error}`)
    }
  }
}

export const NO_TERMINAL_OUTPUT =
  "Pointer has not seen a terminal command finish yet. Run one in the integrated terminal first (shell integration must be on)."
