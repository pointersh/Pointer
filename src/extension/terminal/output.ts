
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

export const MAX_OUTPUT_CHARS = 12000
export const MAX_OUTPUT_LINES = 200

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g

export const stripAnsi = (text: string): string => text.replace(ANSI, "")

export const tailOutput = (
  output: string,
  { maxChars = MAX_OUTPUT_CHARS, maxLines = MAX_OUTPUT_LINES } = {}
): string => {
  const lines = stripAnsi(output).replace(/\s+$/, "").split("\n")
  let kept = lines.slice(-maxLines)
  let text = kept.join("\n")
  while (text.length > maxChars && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 4))
    text = kept.join("\n")
  }
  if (text.length > maxChars) text = text.slice(-maxChars)
  const dropped = lines.length - kept.length
  return dropped > 0 ? `[${dropped} earlier lines not shown]\n${text}` : text
}

const LOCATION_PATTERNS = [
  /(?:^|[\s("'`[])((?:[A-Za-z]:)?[^\s:"'`()[\]]+?\.[A-Za-z0-9]{1,10}):(\d+)(?::(\d+))?(?=[\s:)"'`\],]|$)/gm,
  /(?:^|[\s("'`])((?:[A-Za-z]:)?[^\s:"'`()]+?\.[A-Za-z0-9]{1,10})\((\d+),(\d+)\)/gm,
  /File "([^"]+)", line (\d+)/g
]

const NOT_CODE = /^(https?:|file:|node:|internal\/)/i
const LIBRARY = /(^|[\\/])(node_modules|site-packages|\.venv|venv|dist|out|build)[\\/]/

export const runFailed = (run: TerminalRun): boolean =>
  run.exitCode !== undefined
    ? run.exitCode !== 0
    : /\b(error|exception|traceback|failed|fatal|panic)\b/i.test(run.output)

export const formatTerminalRun = (run: TerminalRun): string => {
  const status =
    run.exitCode === undefined
      ? ""
      : run.exitCode === 0
        ? " (exit code 0)"
        : ` (failed with exit code ${run.exitCode})`
  const output = tailOutput(run.output)
  return [
    `Terminal command${status}${run.cwd ? ` in ${run.cwd}` : ""}:`,
    "```",
    run.commandLine.trim() || "(unknown command)",
    "```",
    "Output:",
    "```",
    output.trim() || "(no output)",
    "```"
  ].join("\n")
}
