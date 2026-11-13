import { API_PROVIDERS } from "../../common/constants"
import { deadline } from "../../common/deadline"
import { getProviderOrigin, HOSTED_PROVIDERS } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"

const KEEP_MS = 30_000
const RETRY_UNKNOWN_MS = 3000
const ASK_TIMEOUT_MS = 1500

const HOSTED_ASSUMED_TOKENS = 128_000
const LOCAL_ASSUMED_TOKENS = 32_768

interface Known {
  tokens?: number
  at: number
}

const known = new Map<string, Known>()

const keyOf = (provider: PointerProvider) =>
  [provider.provider, provider.apiHostname ?? "", provider.apiPort ?? "", provider.modelName].join("|")

export const originOf = (provider: PointerProvider) =>
  getProviderOrigin({ ...provider, apiHostname: provider.apiHostname || "localhost" })

export const ask = async (provider: PointerProvider, url: string, body?: unknown): Promise<unknown> => {
  const { signal, done } = deadline(ASK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal
    })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  } finally {
    done()
  }
}

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

export const sameOllamaModel = (a: string, b: string) => {
  const tagged = (name: string) => (name.includes(":") ? name : `${name}:latest`)
  return tagged(a) === tagged(b)
}

const fromOllama = async (provider: PointerProvider): Promise<number | undefined> => {
  const origin = originOf(provider)
  const loaded = (await ask(provider, `${origin}/api/ps`)) as
    | { models?: { name?: string; model?: string; context_length?: unknown }[] }
    | undefined
  const running = loaded?.models?.find(
    (model) =>
      sameOllamaModel(model.name ?? "", provider.modelName) || sameOllamaModel(model.model ?? "", provider.modelName)
  )
  const now = positive(running?.context_length)
  if (now) return now
  const shown = (await ask(provider, `${origin}/api/show`, { model: provider.modelName })) as
    | { parameters?: unknown }
    | undefined
  const set = typeof shown?.parameters === "string" ? /^\s*num_ctx\s+(\d+)/m.exec(shown.parameters) : null
  return set ? positive(Number(set[1])) : undefined
}

const fromLlamaCpp = async (provider: PointerProvider): Promise<number | undefined> => {
  const query = provider.modelName
    ? `?model=${encodeURIComponent(provider.modelName)}&autoload=false`
    : ""
  const props = (await ask(provider, `${originOf(provider)}/props${query}`)) as
    | { default_generation_settings?: { n_ctx?: unknown } }
    | undefined
  return positive(props?.default_generation_settings?.n_ctx)
}

const fromLmStudio = async (provider: PointerProvider): Promise<number | undefined> => {
  const listing = (await ask(provider, `${originOf(provider)}/api/v0/models`)) as
    | { data?: { id?: string; loaded_context_length?: unknown }[] }
    | undefined
  return positive(listing?.data?.find((model) => model.id === provider.modelName)?.loaded_context_length)
}

const detect = (provider: PointerProvider): Promise<number | undefined> => {
  switch (provider.provider) {
    case API_PROVIDERS.Ollama:
      return fromOllama(provider)
    case API_PROVIDERS.LlamaCpp:
      return fromLlamaCpp(provider)
    case API_PROVIDERS.LMStudio:
      return fromLmStudio(provider)
    default:
      return Promise.resolve(undefined)
  }
}

export const contextWindowOf = async (provider: PointerProvider): Promise<number | undefined> => {
  const key = keyOf(provider)
  const cached = known.get(key)
  const age = cached ? Date.now() - cached.at : Infinity
  if (cached && age < (cached.tokens ? KEEP_MS : RETRY_UNKNOWN_MS)) return cached.tokens
  const tokens = await detect(provider)
  known.set(key, { tokens, at: Date.now() })
  return tokens
}

export const knownContextWindow = (provider: PointerProvider): number | undefined =>
  known.get(keyOf(provider))?.tokens

export const assumedContextWindow = (provider: PointerProvider): number =>
  HOSTED_PROVIDERS.includes(provider.provider) ? HOSTED_ASSUMED_TOKENS : LOCAL_ASSUMED_TOKENS

export const forgetContextWindows = () => known.clear()
