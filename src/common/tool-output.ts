
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", pyi: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
  swift: "swift", lua: "lua", pl: "perl", r: "r", scala: "scala", dart: "dart", ex: "elixir", exs: "elixir",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell",
  json: "json", jsonc: "json", json5: "json5", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  md: "markdown", mdx: "markdown", css: "css", scss: "scss", sass: "sass", less: "less",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf", dockerfile: "docker",
  diff: "diff", patch: "diff"
}

export const languageForPath = (path: string): string => {
  const name = path.split("/").pop()?.toLowerCase() ?? ""
  if (name === "dockerfile") return "docker"
  if (name === "makefile") return "makefile"
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : ""
  return EXTENSION_LANGUAGES[extension] ?? "text"
}

export interface FileSlice {
  path: string
  startLine: number
  code: string
  note?: string
}

export const parseReadFile = (output: string): FileSlice | undefined => {
  const [header, ...rest] = output.split("\n")
  const match = header.match(/^(.+) \(lines (\d+)–(\d+) of \d+\)$/)
  if (!match) return undefined
  const code: string[] = []
  let note: string | undefined
  let expected = Number(match[2])
  for (const line of rest) {
    const numbered = line.match(/^(\d+): ?(.*)$/)
    if (numbered && Number(numbered[1]) === expected) {
      code.push(numbered[2])
      expected++
    } else if (line.startsWith("… ")) {
      note = line.slice(2)
    }
  }
  return { path: match[1], startLine: Number(match[2]), code: code.join("\n"), note }
}

export interface CommandRun {
  command: string
  status: string
  output: string
  isDiff: boolean
}

export const parseCommandRun = (output: string): CommandRun | undefined => {
  const match = output.match(/^\$ (.*)\n\(([^)\n]*)\)\n?([\s\S]*)$/)
  if (!match) return undefined
  const printed = match[3]
  return {
    command: match[1],
    status: match[2],
    output: printed,
    isDiff: /^(diff --git |--- a\/|\+\+\+ b\/|@@ -\d)/m.test(printed)
  }
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export const classifyDiff = (diff: string): DiffLine[] =>
  diff.replace(/\n$/, "").split("\n").map((text) => {
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(text)) {
      return { kind: "meta", text }
    }
    if (text.startsWith("@@")) return { kind: "hunk", text }
    if (text.startsWith("+")) return { kind: "add", text }
    if (text.startsWith("-")) return { kind: "del", text }
    return { kind: "context", text }
  })

export const replacementDiff = (find: string, replace: string): DiffLine[] => [
  ...find.replace(/\n$/, "").split("\n").map((text) => ({ kind: "del" as const, text: `-${text}` })),
  ...replace.replace(/\n$/, "").split("\n").map((text) => ({ kind: "add" as const, text: `+${text}` }))
]

export interface CodeHitBlock {
  path: string
  startLine: number
  endLine: number
  relevance: string
  code?: string
}

export const parseSearchHits = (output: string): CodeHitBlock[] => {
  const blocks: CodeHitBlock[] = []
  const header = /^(.+):(\d+)-(\d+) \(relevance ([\d.]+)\)$/
  for (const line of output.split("\n")) {
    const match = line.match(header)
    if (match) {
      blocks.push({ path: match[1], startLine: Number(match[2]), endLine: Number(match[3]), relevance: match[4], code: "" })
    } else if (blocks.length) {
      const block = blocks[blocks.length - 1]
      block.code = block.code ? `${block.code}\n${line}` : line
    }
  }
  return blocks.map((block) => {
    const code = block.code?.replace(/\n+$/, "")
    return { ...block, code: !code || code.startsWith("… (not shown") ? undefined : code }
  })
}

export interface LocatedLine {
  path: string
  line: number
  text: string
  context?: boolean
}

export const parseLocatedLines = (output: string): LocatedLine[] | undefined => {
  const located: LocatedLine[] = []
  let file: string | undefined
  for (const line of output.split("\n")) {
    if (!line.trim() || line === "--" || line.startsWith("… ") || line.startsWith("(")) continue
    const flat = line.match(/^([^:\n]+):(\d+): (.*)$/)
    if (flat) {
      located.push({ path: flat[1], line: Number(flat[2]), text: flat[3] })
      continue
    }
    const numbered = line.match(/^(\d+)([:-]) ?(.*)$/)
    if (numbered && file) {
      located.push({
        path: file,
        line: Number(numbered[1]),
        text: numbered[3],
        ...(numbered[2] === "-" ? { context: true } : {})
      })
    } else if (!numbered) file = line
  }
  return located.some((line) => !line.context) ? located : undefined
}

export const groupByFile = (lines: LocatedLine[]): { path: string; lines: LocatedLine[] }[] => {
  const groups: { path: string; lines: LocatedLine[] }[] = []
  for (const line of lines) {
    const last = groups[groups.length - 1]
    if (last?.path === line.path) last.lines.push(line)
    else groups.push({ path: line.path, lines: [line] })
  }
  return groups
}
