
export interface SyntaxLike {
  type: string
  startPosition: { row: number }
  endPosition: { row: number; column?: number }
  children: SyntaxLike[]
}

export type LineRange = [number, number]

const IMPORT_NODE = /import|use_declaration|preproc_include/
const COMMENT_NODE = /comment/

const lineChars = (lines: string[], from: number, to: number): number => {
  let total = 0
  for (let i = from; i <= to && i < lines.length; i++) total += lines[i].length + 1
  return total
}

const lastRow = (node: SyntaxLike, lineCount: number): number => {
  const { row, column } = node.endPosition
  const last = column === 0 && row > node.startPosition.row ? row - 1 : row
  return Math.min(last, Math.max(0, lineCount - 1))
}

const contains = (node: SyntaxLike, start: number, end: number, lineCount: number) =>
  node.startPosition.row <= start && lastRow(node, lineCount) >= end

export const enclosingRange = (
  root: SyntaxLike,
  lines: string[],
  start: number,
  end: number,
  maxChars: number
): LineRange | undefined => {
  let node: SyntaxLike | undefined = root
  while (node) {
    const from = node.startPosition.row
    const to = lastRow(node, lines.length)
    const grows = from < start || to > end
    if (grows && lineChars(lines, from, to) <= maxChars) return [from, to]
    node = node.children.find((child) => contains(child, start, end, lines.length))
  }
  return undefined
}

export const importRange = (
  root: SyntaxLike,
  lines: string[],
  maxChars: number
): LineRange | undefined => {
  let first: number | undefined
  let last: number | undefined
  for (const child of root.children) {
    if (IMPORT_NODE.test(child.type)) {
      first ??= child.startPosition.row
      last = lastRow(child, lines.length)
    } else if (first !== undefined && !COMMENT_NODE.test(child.type)) {
      break
    }
  }
  if (first === undefined || last === undefined) return undefined
  return lineChars(lines, first, last) <= maxChars ? [first, last] : undefined
}
