interface SymbolRef {
  path: string
  line: number
  name: string
}

const PREFIX = "symbol:"

export const encodeSymbolRef = (ref: SymbolRef): string =>
  `${PREFIX}${ref.line}:${encodeURIComponent(ref.name)}:${ref.path}`

const isSymbolRef = (id: string): boolean => id.startsWith(PREFIX)

export const decodeSymbolRef = (id: string): SymbolRef | undefined => {
  if (!isSymbolRef(id)) return undefined
  const match = /^symbol:(\d+):([^:]*):(.+)$/.exec(id)
  if (!match) return undefined
  return {
    line: Number(match[1]),
    name: decodeURIComponent(match[2]),
    path: match[3]
  }
}
