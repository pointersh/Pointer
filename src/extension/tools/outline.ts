
const DECLARATION = new RegExp(
  [
    "^\\s{0,4}(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:pub(?:\\([a-z]+\\))?\\s+)?(?:function\\*?|class|interface|type|enum|def|fn|func|struct|impl|trait|module|namespace|object|record)\\s+([A-Za-z_$][\\w$]*)",
    "^(?:export\\s+)?(?:const|let|var|val)\\s+([A-Za-z_$][\\w$]*)\\s*[=:]",
    "^\\s{2,4}(?:(?:public|private|protected|static|readonly|async|override|get|set)\\s+)*\\*?([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)\\s*(?::[^=]*)?\\{\\s*$",
    "^func\\s+\\([^)]*\\)\\s*([A-Za-z_]\\w*)"
  ].join("|")
)

const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try"])

interface Declaration {
  line: number
  name: string
}

export const outlineOf = (lines: string[], from = 0, to = lines.length, max = 60): { found: Declaration[]; more: boolean } => {
  const found: Declaration[] = []
  let more = false
  for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) {
    const line = lines[i]
    if (line.length > 300) continue
    const match = DECLARATION.exec(line)
    const name = match?.slice(1).find(Boolean)
    if (!name || NOT_NAMES.has(name)) continue
    if (found.length >= max) {
      more = true
      break
    }
    found.push({ line: i + 1, name })
  }
  return { found, more }
}

export const outlineText = (declarations: Declaration[]) =>
  declarations.map(({ line, name }) => `${name} (${line})`).join(", ")
