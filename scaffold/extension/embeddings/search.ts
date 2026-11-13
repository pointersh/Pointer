import * as fs from "fs/promises"
import { workspace } from "vscode"

import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"
import { getParser } from "../parser"

import { EmbeddingDatabase } from "./database"
import { Embedder } from "./embedder"
import { enclosingRange, importRange, SyntaxLike } from "./expand"
import {
  Candidate,
  fitHitsToBudget,
  fuseRankings,
  Hit,
  keywordQuery,
  mergeAdjacentHits
} from "./rank"
import { Reranker } from "./reranker"

const RETRIEVE_LIMIT = 20
const RERANK_LIMIT = 12
const FOCUS_LIMIT = 6
const FOCUS_FILE_LIMIT = 8
const IMPORT_CHARS = 1200

export interface SearchOptions {
  limit: number
  threshold: number
  maxChars: number
  focus?: string[]
  expandChars?: number
  onProgress?: (progress: SearchProgress) => void
}

export type SearchProgress =
  | { stage: "embedding" }
  | { stage: "retrieving" }
  | { stage: "reranking"; candidates: number }

export interface SearchResult {
  hits: Hit[]
  candidates: number
  nearMisses: Hit[]
  note?: string
}

const NEAR_MISS_LIMIT = 3

export interface ParsedFile {
  root: SyntaxLike
  dispose(): void
}

export type FileParser = (file: string, text: string) => Promise<ParsedFile | undefined>

const parseWithTreeSitter: FileParser = async (file, text) => {
  const parser = await getParser(file)
  if (!parser) return undefined
  const tree = parser.parse(text)
  return { root: tree.rootNode, dispose: () => tree.delete() }
}

export { Hit }

export class WorkspaceSearch {
  private readonly _reportedParseErrors = new Set<string>()
  constructor(
    private readonly _db: EmbeddingDatabase,
    private readonly _embedder: Embedder,
    private readonly _reranker: Reranker,
    private readonly _parse: FileParser = parseWithTreeSitter,
    private readonly _includesFile: (file: string) => boolean = () => true
  ) {}

  public get available(): boolean {
    return this._db.hasIndex
  }

  public async search(query: string, options: SearchOptions): Promise<Hit[]> {
    return (await this.searchDetailed(query, options)).hits
  }

  public async searchDetailed(
    query: string,
    options: SearchOptions
  ): Promise<SearchResult> {
    const text = query.trim()
    const empty: SearchResult = { hits: [], candidates: 0, nearMisses: [] }
    if (!text || !this.available) return empty
    const progress = options.onProgress ?? (() => undefined)

    progress({ stage: "embedding" })
    const notes: string[] = []
    const vector = await this.embedQuery(text, notes)
    progress({ stage: "retrieving" })
    const keywords = keywordQuery(text)
    const focus = (options.focus ?? []).filter(this._includesFile).slice(0, FOCUS_FILE_LIMIT)
    const lists = await Promise.all([
      vector ? this._db.vectorSearch(vector, RETRIEVE_LIMIT) : [],
      this._db.textSearch(keywords, RETRIEVE_LIMIT),
      vector && focus.length ? this._db.vectorSearch(vector, FOCUS_LIMIT, focus) : [],
      focus.length ? this._db.textSearch(keywords, FOCUS_LIMIT, focus) : []
    ])
    const candidates = fuseRankings(lists)
      .filter((candidate) => this._includesFile(candidate.file))
      .slice(0, RERANK_LIMIT)
    if (!candidates.length) return { ...empty, note: notes[0] }

    progress({ stage: "reranking", candidates: candidates.length })
    const scored = await this.score(text, candidates, notes)
    const kept = scored
      .filter((hit) => hit.score >= options.threshold)
      .sort((a, b) => b.score - a.score)
    const nearMisses = scored
      .filter((hit) => hit.score < options.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, NEAR_MISS_LIMIT)

    const sources = new Map<string, string[] | undefined>()
    for (const file of new Set(kept.map((hit) => hit.file))) {
      sources.set(file, await this.readLines(file))
    }
    const { widened, imports } = await this.widen(kept, sources, options.expandChars)
    const merged = mergeAdjacentHits(widened, (file) => sources.get(file)).slice(
      0,
      options.limit
    )
    const trailing = [...imports.values()].filter(
      (block) =>
        merged.some((hit) => hit.file === block.file) &&
        !merged.some(
          (hit) =>
            hit.file === block.file &&
            hit.startLine <= block.startLine &&
            hit.endLine >= block.endLine
        )
    )
    return {
      hits: fitHitsToBudget([...merged, ...trailing], options.maxChars),
      candidates: candidates.length,
      nearMisses,
      note: notes[0]
    }
  }

  private async embedQuery(
    text: string,
    notes: string[]
  ): Promise<number[] | undefined> {
    try {
      return await this._embedder.embedOne(text, "query")
    } catch (error) {
      logger.error(`Semantic search skipped: ${error}`)
      notes.push("The embedding server did not answer, so only keywords were matched.")
      return undefined
    }
  }

  private async score(
    text: string,
    candidates: Candidate[],
    notes: string[]
  ): Promise<Hit[]> {
    const scores = await this._reranker.rerank(
      text,
      candidates.map(
        (candidate) => `${workspace.asRelativePath(candidate.file)}\n${candidate.content}`
      )
    )
    if (!scores) {
      notes.push("The reranker is unavailable, so scores are retrieval order.")
      return candidates.map((candidate, i) => ({
        ...candidate,
        score: 1 - i / candidates.length
      }))
    }
    return candidates.map((candidate, i) => ({ ...candidate, score: scores[i] }))
  }

  private async widen(
    hits: Hit[],
    sources: Map<string, string[] | undefined>,
    maxChars: number | undefined
  ): Promise<{ widened: Hit[]; imports: Map<string, Hit> }> {
    const imports = new Map<string, Hit>()
    if (!maxChars) return { widened: hits, imports }

    const widened: Hit[] = []
    const byFile = new Map<string, Hit[]>()
    for (const hit of hits) byFile.set(hit.file, [...(byFile.get(hit.file) || []), hit])

    for (const [file, fileHits] of byFile) {
      const lines = sources.get(file)
      const parsed = lines && (await this.parseSafely(file, lines.join("\n")))
      if (!lines || !parsed) {
        widened.push(...fileHits)
        continue
      }
      try {
        const slice = ([from, to]: [number, number]) => lines.slice(from, to + 1).join("\n")
        for (const hit of fileHits) {
          const range = enclosingRange(parsed.root, lines, hit.startLine, hit.endLine, maxChars)
          widened.push(
            range
              ? { ...hit, startLine: range[0], endLine: range[1], content: slice(range) }
              : hit
          )
        }
        const range = importRange(parsed.root, lines, IMPORT_CHARS)
        if (range) {
          imports.set(file, {
            file,
            startLine: range[0],
            endLine: range[1],
            content: slice(range),
            score: Math.max(...fileHits.map((hit) => hit.score)),
            kind: "imports"
          })
        }
      } finally {
        parsed.dispose()
      }
    }
    return { widened, imports }
  }

  private async parseSafely(file: string, text: string): Promise<ParsedFile | undefined> {
    try {
      return await this._parse(file, text)
    } catch (error) {
      const message = messageOf(error)
      if (!this._reportedParseErrors.has(message)) {
        this._reportedParseErrors.add(message)
        logger.warn(`Could not parse ${file} to widen hits (hits stay as chunks): ${message}`)
      }
      return undefined
    }
  }

  private async readLines(file: string): Promise<string[] | undefined> {
    const open = workspace.textDocuments.find((document) => document.uri.fsPath === file)
    if (open) return open.getText().split("\n")
    try {
      return (await fs.readFile(file, "utf-8")).split("\n")
    } catch {
      return undefined
    }
  }
}
