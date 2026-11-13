
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

export const extractFileLocations = (output: string): FileLocation[] => {
  const found: FileLocation[] = []
  const seen = new Set<string>()
  const text = stripAnsi(output)
  for (const pattern of LOCATION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const path = match[1].replace(/^\.\//, "")
      if (NOT_CODE.test(path) || LIBRARY.test(path) || path.startsWith("<")) {
        continue
      }
      const line = Number(match[2])
      if (!line) continue
      const column = match[3] ? Number(match[3]) : undefined
      const key = `${path}:${line}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ path, line, column })
    }
  }
  return found
}

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

export const extractShellCommand = (reply: string): string => {
  const text = reply.trim()
  const fence = /```[a-zA-Z]*\n([\s\S]*?)\n?```/.exec(text)
  const candidate = (fence ? fence[1] : text)
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !line.startsWith("#") && !/^[A-Za-z][^`]*:$/.test(line)
    )[0]
  if (!candidate) return ""
  return candidate
    .replace(/^\$\s+/, "")
    .replace(/^`(.*)`$/, "$1")
    .trim()
}
