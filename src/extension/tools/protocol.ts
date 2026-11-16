
export interface ToolCall {
  name: string
  args: Record<string, string>
}

const ESCAPES = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t", "u"])

const repairJson = (text: string): string => {
  let out = ""
  let inString = false
  let last = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === "\\") {
        const next = text[i + 1] ?? ""
        const valid = next === "u" ? /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)) : ESCAPES.has(next)
        out += valid ? `\\${next}` : `\\\\${next}`
        i++
      } else if (char === "\"") {
        inString = false
        out += char
      } else if (char === "\n") out += "\\n"
      else if (char === "\r") out += "\\r"
      else if (char === "\t") out += "\\t"
      else if (char < " ") out += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
      else out += char
      continue
    }
    if (/\s/.test(char)) {
      out += char
      continue
    }
    if (char === ",") {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next])) next++
      if (text[next] === "}" || text[next] === "]") continue
    }
    const key = last === "{" || last === "," ? /^([A-Za-z_$][\w$]*)(\s*:)/.exec(text.slice(i, i + 200)) : null
    if (key) {
      out += `"${key[1]}"${key[2]}`
      i += key[0].length - 1
      last = ":"
      continue
    }
    if (char === "\"") inString = true
    out += char
    last = char
  }
  return out
}

export const parseLenientJson = (text: string): { value: unknown } | { error: string } => {
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    try {
      return { value: JSON.parse(repairJson(text)) }
    } catch {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}

interface ToolParameter {
  name: string
  description: string
  optional?: boolean
  type?: "string" | "integer" | "boolean"
  schema?: Record<string, unknown>
}

export interface ToolSpec {
  name: string
  description: string
  parameters: ToolParameter[]
  guidance?: string
  readOnly?: boolean
  acts?: boolean
  schema?: Record<string, unknown>
}
