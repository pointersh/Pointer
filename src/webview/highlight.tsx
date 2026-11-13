export type TokenKind = "comment" | "string" | "number" | "keyword" | "fn" | "add" | "del" | "meta" | "tag" | "text"
export type Token = [TokenKind, string]

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue def default defer del delete do elif else enum " +
    "except export extends false final finally fn for from func function go if impl implements import in instanceof " +
    "interface is lambda let loop match mod module mut new nil none not null of or and package pass private protected " +
    "pub public raise readonly return self static struct super switch this throw trait true try type typeof use var " +
    "void where while with yield True False None struct unsafe crate ref move dyn local then end elseif"
  ).split(" ")
)

const FAMILY: Record<string, "c" | "hash" | "diff" | "markup" | "plain"> = {
  js: "c", jsx: "c", ts: "c", tsx: "c", javascript: "c", typescript: "c", java: "c", go: "c", rust: "c", rs: "c",
  c: "c", cpp: "c", cs: "c", kotlin: "c", swift: "c", css: "c", scss: "c", json: "c", jsonc: "c", php: "c", dart: "c",
  py: "hash", python: "hash", sh: "hash", bash: "hash", shell: "hash", zsh: "hash", yaml: "hash", yml: "hash",
  toml: "hash", rb: "hash", ruby: "hash", dockerfile: "hash", makefile: "hash", r: "hash", ini: "hash",
  diff: "diff", patch: "diff",
  html: "markup", xml: "markup", svg: "markup", vue: "markup", md: "plain", markdown: "plain", text: "plain", txt: "plain"
}

const STRING = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + "`(?:\\\\.|[^`\\\\])*`"
const NUMBER = String.raw`\b(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b`
const WORD = String.raw`[A-Za-z_$][\w$]*`

const PATTERNS = {
  c: new RegExp(String.raw`(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(${STRING})|(${NUMBER})|(${WORD})`, "g"),
  hash: new RegExp(String.raw`(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|${STRING})|(${NUMBER})|(${WORD})`, "g"),
  markup: /(<!--[\s\S]*?-->)|("[^"]*"|'[^']*')|(<\/?[\w:-]+|\/?>)/g
}

const tokenizeCode = (code: string, family: "c" | "hash"): Token[] => {
  const tokens: Token[] = []
  const pattern = PATTERNS[family]
  let last = 0
  for (const match of code.matchAll(pattern)) {
    const [text, comment, string, number, word] = match
    const at = match.index ?? 0
    if (at > last) tokens.push(["text", code.slice(last, at)])
    last = at + text.length
    if (comment) tokens.push(["comment", text])
    else if (string) tokens.push(["string", text])
    else if (number) tokens.push(["number", text])
    else if (word && KEYWORDS.has(word)) tokens.push(["keyword", text])
    else if (word && code[last] === "(") tokens.push(["fn", text])
    else tokens.push(["text", text])
  }
  if (last < code.length) tokens.push(["text", code.slice(last)])
  return tokens
}

const tokenizeMarkup = (code: string): Token[] => {
  const tokens: Token[] = []
  let last = 0
  for (const match of code.matchAll(PATTERNS.markup)) {
    const at = match.index ?? 0
    if (at > last) tokens.push(["text", code.slice(last, at)])
    last = at + match[0].length
    tokens.push([match[1] ? "comment" : match[2] ? "string" : "tag", match[0]])
  }
  if (last < code.length) tokens.push(["text", code.slice(last)])
  return tokens
}

const tokenizeDiff = (code: string): Token[] =>
  code.split(/(?<=\n)/).map((line): Token => {
    if (line.startsWith("@@")) return ["meta", line]
    if (line.startsWith("+") && !line.startsWith("+++")) return ["add", line]
    if (line.startsWith("-") && !line.startsWith("---")) return ["del", line]
    return ["text", line]
  })

export const tokenize = (code: string, language = "text"): Token[] => {
  const family = FAMILY[language.toLowerCase()] ?? "c"
  if (family === "diff") return tokenizeDiff(code)
  if (family === "markup") return tokenizeMarkup(code)
  if (family === "plain") return [["text", code]]
  return tokenizeCode(code, family)
}

const render = (tokens: Token[]) =>
  tokens.map(([kind, text], i) => (kind === "text" ? text : <span key={i} className={`hl-${kind}`}>{text}</span>))

interface CodeProps {
  code: string
  language?: string
  startLine?: number
  className?: string
}

export const Code = ({ code, language, startLine, className }: CodeProps) => {
  if (startLine === undefined) {
    return (
      <pre className={["hl", className].filter(Boolean).join(" ")}>
        <code>{render(tokenize(code, language))}</code>
      </pre>
    )
  }
  return (
    <pre className={["hl", "hl-numbered", className].filter(Boolean).join(" ")}>
      <code>
        {code.split("\n").map((line, i) => (
          <span key={i} className="hl-line" data-line={startLine + i}>
            {render(tokenize(line, language))}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  )
}
