
export interface Hit {
  file: string
  content: string
  startLine: number
  endLine: number
  score: number
  kind?: "imports" | "team"
}

export type Candidate = Omit<Hit, "score">

const candidateKey = (candidate: Candidate) =>
  `${candidate.file}:${candidate.startLine}-${candidate.endLine}:${candidate.content.length}`

export const fuseRankings = (
  lists: Candidate[][],
  k = 60
): Candidate[] => {
  const scores = new Map<string, { candidate: Candidate; score: number }>()
  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const key = candidateKey(candidate)
      const entry = scores.get(key) || { candidate, score: 0 }
      entry.score += 1 / (k + rank + 1)
      scores.set(key, entry)
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.candidate)
}

export const sigmoid = (logit: number) => 1 / (1 + Math.exp(-logit))

export const mergeAdjacentHits = (
  hits: Hit[],
  lines: (file: string) => string[] | undefined,
  maxChars = 4000
): Hit[] => {
  const byFile = new Map<string, Hit[]>()
  for (const hit of hits) {
    byFile.set(hit.file, [...(byFile.get(hit.file) || []), hit])
  }

  const merged: Hit[] = []
  for (const [file, fileHits] of byFile) {
    const source = lines(file)
    const ordered = [...fileHits].sort((a, b) => a.startLine - b.startLine)
    let current = ordered[0]
    for (const next of ordered.slice(1)) {
      const endLine = Math.max(current.endLine, next.endLine)
      const joined = source?.slice(current.startLine, endLine + 1).join("\n")
      if (joined !== undefined && next.startLine <= current.endLine + 1 && joined.length <= maxChars) {
        current = {
          ...current,
          endLine,
          content: joined,
          score: Math.max(current.score, next.score),
          kind: current.kind === next.kind ? current.kind : undefined
        }
      } else {
        merged.push(current)
        current = next
      }
    }
    merged.push(current)
  }
  return merged.sort((a, b) => b.score - a.score)
}

export const fitHitsToBudget = (hits: Hit[], maxChars: number): Hit[] => {
  const kept: Hit[] = []
  let remaining = maxChars
  for (const hit of hits) {
    if (hit.content.length > remaining) continue
    kept.push(hit)
    remaining -= hit.content.length
  }
  return kept
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "then", "also", "of", "in",
  "on", "to", "for", "with", "from", "by", "at", "as", "is", "are", "was",
  "were", "be", "been", "do", "does", "did", "can", "could", "should",
  "would", "will", "how", "what", "where", "why", "when", "which", "who",
  "i", "me", "my", "we", "you", "your", "it", "its", "this", "that",
  "these", "those", "they", "them", "there", "ok", "okay", "please", "about"
])

export const splitIdentifier = (token: string): string[] =>
  token
    .split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 1)

const identifiers = (text: string): string[] =>
  text.match(/[A-Za-z_][A-Za-z0-9_]+/g) || []

export const keywordText = (text: string): string => {
  const words: string[] = []
  for (const token of identifiers(text)) {
    const whole = token.toLowerCase()
    const parts = splitIdentifier(token)
    words.push(whole)
    if (parts.length > 1 || parts[0] !== whole) words.push(...parts)
  }
  return words.join(" ")
}

export const pathKeywords = (relativePath: string): string => {
  const words = new Set<string>()
  for (const token of relativePath.split(/[^A-Za-z0-9_]+/)) {
    if (!token) continue
    words.add(token.toLowerCase())
    for (const part of splitIdentifier(token)) words.add(part)
  }
  return [...words].join(" ")
}

export const keywordQuery = (text: string): string => {
  const words = new Set<string>()
  for (const token of identifiers(text)) {
    const whole = token.toLowerCase()
    if (!STOP_WORDS.has(whole)) words.add(whole)
    for (const part of splitIdentifier(token)) {
      if (!STOP_WORDS.has(part)) words.add(part)
    }
  }
  return [...words].join(" ")
}

export const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`

const PRONOUN = /\b(it|its|this|that|these|those|they|them|there|one|ones)\b/i

const contentWords = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z_][a-z0-9_]+/g) || []).filter(
    (word) => !STOP_WORDS.has(word)
  )

export const isFollowUp = (text: string): boolean => {
  const words = contentWords(text)
  if (words.length < 2) return true
  return words.length < 3 && PRONOUN.test(text)
}

export const searchQuery = (text: string, previous?: string): string => {
  const current = text.trim()
  const before = previous?.trim()
  if (!before || !current || !isFollowUp(current)) return current
  return `${before}\n${current}`
}
