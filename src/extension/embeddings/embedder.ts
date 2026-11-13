import { getEndpointDefaults } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"
import { isInferenceError, resolveInferenceProvider } from "../inference"
import { describeProviderErrorPlain } from "../providers/errors"

const BATCH_SIZE = 16
const EMBED_TIMEOUT_MS = 60_000
const LOCAL_PARALLEL = 4
const RATE_LIMIT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]

export interface EmbedderOptions {
  rateLimitDelaysMs?: number[]
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isRateLimited = (error: unknown): boolean =>
  (isInferenceError(error) && error.kind === "rate-limited") ||
  (error as { status?: number } | null)?.status === 429

export type EmbedKind = "document" | "query"

const TASK_PREFIXES: Array<{ match: RegExp; document: string; query: string }> = [
  { match: /nomic-embed/i, document: "search_document: ", query: "search_query: " },
  { match: /e5-/i, document: "passage: ", query: "query: " }
]

export const withTaskPrefix = (
  model: string,
  kind: EmbedKind,
  text: string
): string => {
  const prefix = TASK_PREFIXES.find((entry) => entry.match.test(model))
  return prefix ? `${prefix[kind]}${text}` : text
}

const embeddingPath = (provider: PointerProvider): string =>
  getEndpointDefaults(provider.provider, "embedding")?.apiPath ?? ""

export class Embedder {
  private _singleOnly = false

  constructor(
    private readonly _getProvider: () => PointerProvider | undefined,
    private readonly _options: EmbedderOptions = {}
  ) {}

  public get provider(): PointerProvider | undefined {
    return this._getProvider()
  }

  public get parallel(): number {
    const provider = this._getProvider()
    return LOCAL_PARALLEL
  }

  public get model(): string | undefined {
    return this._getProvider()?.modelName
  }

  public async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    const provider = this._getProvider()
    if (!provider) {
      throw new Error("No embedding provider is set. Add one in the providers tab.")
    }
    if (!texts.length) return []

    const inputs = texts.map((text) => withTaskPrefix(provider.modelName, kind, text))
    const vectors: number[][] = []
    for (let offset = 0; offset < inputs.length; offset += BATCH_SIZE) {
      vectors.push(...(await this.embedBatch(provider, inputs.slice(offset, offset + BATCH_SIZE))))
    }
    return vectors
  }

  public async embedOne(text: string, kind: EmbedKind): Promise<number[]> {
    const [vector] = await this.embed([text], kind)
    return vector
  }

  private async embedBatch(
    provider: PointerProvider,
    inputs: string[]
  ): Promise<number[][]> {
    if (!this._singleOnly && inputs.length > 1) {
      try {
        const vectors = await this.request(provider, inputs)
        if (vectors.length === inputs.length) return vectors
      } catch (error) {
        const status = (error as { status?: number }).status
        if (!status || status < 400 || status >= 500 || isRateLimited(error)) throw error
      }
      this._singleOnly = true
    }

    const vectors: number[][] = []
    for (const input of inputs) {
      const [vector] = await this.request(provider, input)
      if (!vector) throw new Error("The server answered but returned no embedding vector.")
      vectors.push(vector)
    }
    return vectors
  }

  private async request(
    provider: PointerProvider,
    input: string | string[]
  ): Promise<number[][]> {
    const delays = this._options.rateLimitDelaysMs ?? RATE_LIMIT_DELAYS_MS
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(provider, input)
      } catch (error) {
        if (!isRateLimited(error) || attempt >= delays.length) throw error
        await wait(delays[attempt])
      }
    }
  }

  private async once(
    provider: PointerProvider,
    input: string | string[]
  ): Promise<number[][]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)

    try {
      const { vectors } = await resolveInferenceProvider({
        ...provider,
        apiPath: provider.apiPath || embeddingPath(provider)
      }).embeddings(
        { model: provider.modelName, input },
        { signal: controller.signal }
      )
      return vectors
    } catch (error) {
      throw Object.assign(new Error(describeProviderErrorPlain(error, provider)), {
        status: (error as { status?: number }).status
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
