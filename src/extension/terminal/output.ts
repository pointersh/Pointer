
export interface TerminalRun {
  commandLine: string
  output: string
  exitCode: number | undefined
  cwd?: string
  terminal: string
  finishedAt: number
}

export interface FileLocation {
  path: string
  line: number
  column?: number
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g

export const stripAnsi = (text: string): string => text.replace(ANSI, "")

export const runFailed = (run: TerminalRun): boolean =>
  run.exitCode !== undefined
    ? run.exitCode !== 0
    : /\b(error|exception|traceback|failed|fatal|panic)\b/i.test(run.output)
