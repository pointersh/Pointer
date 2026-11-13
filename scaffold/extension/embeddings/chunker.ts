import { ExtensionContext } from "vscode"
import { SyntaxNode } from "web-tree-sitter"

import { defaultChunkOptions, EVENT_NAME, EXTENSION_CONTEXT_NAME } from "../../common/constants"
import { ChunkOptions } from "../../common/types"
import { getParser } from "../parser"

export interface Chunk {
  content: string
  startLine: number
  endLine: number
}

type Segment = [number, number]

const lineLength = (lines: string[], from: number, to: number) => {
  let total = 0
  for (let i = from; i <= to; i++) total += lines[i].length + 1
  return total
}

export const syntaxBreaks = (
  root: SyntaxNode,
  maxSize: number
): number[] => {
  const breaks = new Set<number>()
  const visit = (node: SyntaxNode) => {
    if (node.text.length <= maxSize || !node.children.length) {
      breaks.add(node.startPosition.row)
      return
    }
    for (const child of node.children) visit(child)
  }
  for (const child of root.children) visit(child)
  return [...breaks].sort((a, b) => a - b)
}

export const proseBreaks = (lines: string[]): number[] => {
  const breaks: number[] = []
  let previousBlank = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const blank = line.trim() === ""
    if ((previousBlank && !blank) || /^#{1,6}\s/.test(line)) breaks.push(i)
    previousBlank = blank
  }
  return breaks
}

const segmentsFromBreaks = (breaks: number[], lineCount: number): Segment[] => {
  if (!lineCount) return []
  const rows = [...new Set([0, ...breaks.filter((row) => row < lineCount)])]
    .sort((a, b) => a - b)
  return rows.map((row, i) => [row, (rows[i + 1] ?? lineCount) - 1])
}

export const packSegments = (
  lines: string[],
  segments: Segment[],
  options: ChunkOptions
): Chunk[] => {
  const { minSize, maxSize, overlap } = options
  const ranges: Segment[] = []
  let open: Segment | undefined

  const close = () => {
    if (open) ranges.push(open)
    open = undefined
  }

  for (const [start, end] of segments) {
    if (open && lineLength(lines, open[0], end) <= maxSize) {
      open[1] = end
      continue
    }
    close()
    if (lineLength(lines, start, end) <= maxSize) {
      open = [start, end]
      continue
    }
    let from = start
    for (let row = start; row <= end; row++) {
      if (row > from && lineLength(lines, from, row) > maxSize) {
        ranges.push([from, row - 1])
        from = row
      }
    }
    open = [from, end]
  }
  close()

  const merged: Segment[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      lineLength(lines, range[0], range[1]) < minSize &&
      lineLength(lines, previous[0], range[1]) <= maxSize * 1.5
    ) {
      previous[1] = range[1]
    } else {
      merged.push(range)
    }
  }

  return merged
    .flatMap(([start, end], i): Chunk[] => {
      let from = start
      if (i > 0 && overlap > 0) {
        while (from > 0 && lineLength(lines, from - 1, start - 1) <= overlap) from--
      }
      const content = lines.slice(from, end + 1).join("\n")
      if (content.length <= maxSize * 2) return [{ content, startLine: from, endLine: end }]
      const pieces: Chunk[] = []
      for (let offset = 0; offset < content.length; offset += maxSize) {
        pieces.push({
          content: content.slice(offset, offset + maxSize),
          startLine: from,
          endLine: end
        })
      }
      return pieces
    })
    .filter((chunk) => chunk.content.trim().length > 0)
}

export const embeddingWindows = (
  content: string,
  maxChars: number,
  overlap: number
): string[] => {
  if (content.length <= maxChars) return [content]
  const lines = content.split("\n")
  const windows: string[] = []
  let from = 0
  while (from < lines.length) {
    let to = from
    while (to + 1 < lines.length && lineLength(lines, from, to + 1) <= maxChars) to++
    const text = lines.slice(from, to + 1).join("\n")
    if (text.length > maxChars) {
      for (let offset = 0; offset < text.length; offset += maxChars) {
        windows.push(text.slice(offset, offset + maxChars))
      }
    } else {
      windows.push(text)
    }
    if (to + 1 >= lines.length) break
    let next = to + 1
    while (next > from + 1 && lineLength(lines, next - 1, to) <= overlap) next--
    from = next
  }
  return windows.filter((window) => window.trim().length > 0)
}

export const getChunkOptions = (
  context: ExtensionContext | undefined
): ChunkOptions => {
  if (!context) return defaultChunkOptions
  const read = (key: string, fallback: number) =>
    Number(
      context.globalState.get(`${EVENT_NAME.pointerGlobalContext}-${key}`)
    ) || fallback
  const maxSize = read(EXTENSION_CONTEXT_NAME.pointerMaxChunkSize, defaultChunkOptions.maxSize)
  const minSize = Math.min(
    read(EXTENSION_CONTEXT_NAME.pointerMinChunkSize, defaultChunkOptions.minSize),
    maxSize
  )
  const overlap = Math.min(
    read(EXTENSION_CONTEXT_NAME.pointerOverlapSize, defaultChunkOptions.overlap),
    Math.floor(maxSize / 2)
  )
  return { maxSize, minSize, overlap }
}

export const chunkText = (content: string, options: ChunkOptions): Chunk[] => {
  const lines = content.split("\n")
  return packSegments(lines, segmentsFromBreaks(proseBreaks(lines), lines.length), options)
}

export const chunkDocument = async (
  content: string,
  filePath: string,
  options: ChunkOptions
): Promise<Chunk[]> => {
  try {
    const parser = await getParser(filePath)
    if (!parser) return chunkText(content, options)
    const tree = parser.parse(content)
    const lines = content.split("\n")
    const breaks = syntaxBreaks(tree.rootNode, options.maxSize)
    tree.delete()
    return packSegments(lines, segmentsFromBreaks(breaks, lines.length), options)
  } catch (error) {
    console.error(`Could not parse ${filePath} for chunking: ${error}`)
    return chunkText(content, options)
  }
}
