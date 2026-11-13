import { TokenJS } from "fluency.js"

import { API_PROVIDERS } from "../../../common/constants"
import { deadline } from "../../../common/deadline"
import { getProviderOrigin } from "../../../common/provider-validation"
import { PointerProvider } from "../../../common/types"
import {
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  FimChunk,
  FimRequest,
  InferenceCapability,
  InferenceModel,
  InferenceOptions,
  InferenceProvider
} from "../types"

import {
  createStreamRequestBodyFim,
  getFimDataFromProvider,
  usageFromEmbeddingResponse,
  usageFromResponse,
  vectorsFromResponse
} from "./fim-dialects"
import { fluencyChat } from "./fluency"
import { logRequest, responseError, streamJsonLines } from "./json-stream"

const LIST_TIMEOUT_MS = 6_000

interface ListRoute {
  path: string
  parse: (json: unknown) => string[]
}

const names = (items: unknown, key: string): string[] =>
  Array.isArray(items)
    ? items
        .map((item) => (item as Record<string, unknown>)?.[key])
        .filter((name): name is string => typeof name === "string")
    : []

const OLLAMA_TAGS: ListRoute = {
  path: "/api/tags",
  parse: (json) => names((json as { models?: unknown })?.models, "name")
}
const OPENAI_MODELS: ListRoute = {
  path: "/v1/models",
  parse: (json) => names((json as { data?: unknown })?.data, "id")
}
const OPENWEBUI_OLLAMA_TAGS: ListRoute = {
  path: "/ollama/api/tags",
  parse: OLLAMA_TAGS.parse
}
const OPENWEBUI_MODELS: ListRoute = {
  path: "/api/models",
  parse: OPENAI_MODELS.parse
}

const listRoutesFor = (provider: string): ListRoute[] => {
  switch (provider) {
    case API_PROVIDERS.Ollama:
      return [OLLAMA_TAGS, OPENAI_MODELS]
    case API_PROVIDERS.OpenWebUI:
      return [OPENWEBUI_MODELS, OPENWEBUI_OLLAMA_TAGS, OPENAI_MODELS]
    default:
      return [OPENAI_MODELS, OLLAMA_TAGS]
  }
}

export class HttpInferenceProvider implements InferenceProvider {
  public readonly id: string

  constructor(private readonly _config: PointerProvider) {
    this.id = _config.provider
  }

  public capabilities(): InferenceCapability[] {
    return ["fim", "chat", "embeddings"]
  }

  private origin() {
    return getProviderOrigin({
      ...this._config,
      apiHostname: this._config.apiHostname || "localhost"
    })
  }

  private url() {
    return `${this.origin()}${this._config.apiPath || ""}`
  }

  private headers(): Record<string, string> {
    const { apiKey } = this._config
    return {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    }
  }

  public async *fim(
    request: FimRequest,
    options?: InferenceOptions
  ): AsyncGenerator<FimChunk> {
    const kind = this._config.provider
    const body = createStreamRequestBodyFim(kind, request.prompt, {
      model: request.model,
      numPredictFim: request.maxTokens ?? -1,
      temperature: request.temperature,
      keepAlive: request.keepAlive,
      stop: request.stop,
      messages: request.messages
    })
    const lines = streamJsonLines({
      url: this.url(),
      headers: this.headers(),
      body,
      signal: options?.signal
    })
    for await (const line of lines) {
      const text = getFimDataFromProvider(kind, line)
      const usage = usageFromResponse(line)
      if (usage) yield { text: text ?? "", usage }
      else if (text !== undefined) yield { text }
    }
  }

  public chat(request: ChatRequest, options?: InferenceOptions) {
    const client = new TokenJS({
      baseURL: this.url(),
      apiKey: this._config.apiKey
    })
    return fluencyChat(client, this._config, request, options)
  }

  public async embeddings(
    request: EmbeddingRequest,
    options?: InferenceOptions
  ): Promise<EmbeddingResponse> {
    const url = this.url()
    const body = { model: request.model, input: request.input, stream: false }
    logRequest(url, body)
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options?.signal
    })
    if (!response.ok) throw await responseError(response)
    const reply = await response.json()
    const vectors = vectorsFromResponse(reply)
    if (!vectors.length) {
      throw new Error("The server answered but returned no embedding vector.")
    }
    const usage = usageFromEmbeddingResponse(reply)
    return usage ? { vectors, usage } : { vectors }
  }

  public async models(options?: InferenceOptions): Promise<InferenceModel[]> {
    const base = this.origin()
    const attempts = await Promise.allSettled(
      listRoutesFor(this._config.provider).map((route) =>
        this.fetchList(`${base}${route.path}`, route, options?.signal)
      )
    )
    for (const attempt of attempts) {
      if (attempt.status === "fulfilled" && attempt.value.length > 0) {
        return [...new Set(attempt.value)].sort().map((name) => ({
          id: name,
          name,
          capabilities: this.capabilities()
        }))
      }
    }
    const failure = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected"
    )
    if (failure) throw failure.reason
    return []
  }

  private async fetchList(
    url: string,
    route: ListRoute,
    outer?: AbortSignal
  ): Promise<string[]> {
    const { signal, done } = deadline(LIST_TIMEOUT_MS, { parent: outer })
    try {
      const response = await fetch(url, { headers: this.headers(), signal })
      if (!response.ok) throw await responseError(response)
      return route.parse(await response.json())
    } finally {
      done()
    }
  }
}
