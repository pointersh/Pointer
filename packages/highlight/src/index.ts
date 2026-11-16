import bytes from "../highlight.wasm"

export type TokenKind = "comment" | "string" | "number" | "keyword" | "fn" | "add" | "del" | "meta" | "tag" | "text"
export type Token = [TokenKind, string]

interface Exports {
  memory: WebAssembly.Memory
  alloc: (len: number) => number
  dealloc: (ptr: number, len: number) => void
  highlight: (ptr: number, codeLen: number, langLen: number) => number
}

const KINDS: TokenKind[] = ["text", "comment", "string", "number", "keyword", "fn", "add", "del", "meta", "tag"]

const wasm = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as unknown as Exports

export const tokenize = (code: string, language = "text"): Token[] => {
  const lang = language.toLowerCase()
  const size = code.length + lang.length
  const ptr = wasm.alloc(size)
  const input = new Uint16Array(wasm.memory.buffer, ptr, size)
  for (let i = 0; i < code.length; i++) input[i] = code.charCodeAt(i)
  for (let i = 0; i < lang.length; i++) input[code.length + i] = lang.charCodeAt(i)
  const at = wasm.highlight(ptr, code.length, lang.length)
  const words = new Uint32Array(wasm.memory.buffer, at, 1 + new Uint32Array(wasm.memory.buffer, at, 1)[0] * 3)
  const tokens: Token[] = []
  for (let i = 1; i < words.length; i += 3) tokens.push([KINDS[words[i + 2]], code.slice(words[i], words[i] + words[i + 1])])
  wasm.dealloc(ptr, size)
  return tokens
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c])

export const toHtml = (tokens: Token[]): string =>
  tokens.map(([kind, text]) => (kind === "text" ? escape(text) : `<span class="hl-${kind}">${escape(text)}</span>`)).join("")

export const highlight = (code: string, language?: string): string => toHtml(tokenize(code, language))
