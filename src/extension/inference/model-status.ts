import { API_PROVIDERS } from "../../common/constants"
import type { ModelPlace, ModelStatus } from "../../common/model-status"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"

import { ask, contextWindowOf, originOf, sameOllamaModel } from "./context-window"
import { LOOPBACK } from "./shield"

export const placeOf = (provider: PointerProvider): ModelPlace => {
  if (HOSTED_PROVIDERS.includes(provider.provider)) return "hosted"
  return LOOPBACK.test((provider.apiHostname || "localhost").trim()) ? "machine" : "network"
}

const keyOf = (provider: PointerProvider) =>
  [provider.provider, provider.apiHostname ?? "", provider.apiPort ?? "", provider.modelName].join("|")

const loadTimes = new Map<string, number>()

export const rememberLoad = (provider: PointerProvider, ms: number) => loadTimes.set(keyOf(provider), ms)

interface Loaded {
  loaded?: boolean
  gpuShare?: number
}

const share = (part: unknown, whole: unknown): number | undefined =>
  typeof part === "number" && typeof whole === "number" && whole > 0
    ? Math.min(1, Math.max(0, part / whole))
    : undefined

const ollamaLoaded = async (provider: PointerProvider): Promise<Loaded> => {
  const running = (await ask(provider, `${originOf(provider)}/api/ps`)) as
    | { models?: { name?: string; model?: string; size?: unknown; size_vram?: unknown }[] }
    | undefined
  if (!running?.models) return {}
  const mine = running.models.find(
    (model) =>
      sameOllamaModel(model.name ?? "", provider.modelName) || sameOllamaModel(model.model ?? "", provider.modelName)
  )
  return mine ? { loaded: true, gpuShare: share(mine.size_vram, mine.size) } : { loaded: false }
}

const lmStudioLoaded = async (provider: PointerProvider): Promise<Loaded> => {
  const listing = (await ask(provider, `${originOf(provider)}/api/v0/models`)) as
    | { data?: { id?: string; state?: unknown }[] }
    | undefined
  const mine = listing?.data?.find((model) => model.id === provider.modelName)
  return typeof mine?.state === "string" ? { loaded: mine.state === "loaded" } : {}
}

const loadedOf = (provider: PointerProvider): Promise<Loaded> => {
  switch (provider.provider) {
    case API_PROVIDERS.Ollama:
      return ollamaLoaded(provider)
    case API_PROVIDERS.LMStudio:
      return lmStudioLoaded(provider)
    default:
      return Promise.resolve({})
  }
}

export const modelStatusOf = async (provider: PointerProvider, canLoad: boolean): Promise<ModelStatus> => {
  const place = placeOf(provider)
  const local = place === "machine" || place === "network"
  const [loaded, contextWindow] = await Promise.all([
    local ? loadedOf(provider) : Promise.resolve<Loaded>({}),
    contextWindowOf(provider)
  ])
  const loadMs = loadTimes.get(keyOf(provider))
  return {
    place,
    ...(place === "network" ? { host: (provider.apiHostname || "").trim() } : {}),
    ...(loaded.loaded === undefined ? {} : { loaded: loaded.loaded }),
    ...(loaded.loaded === false && canLoad ? { canLoad: true } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(loaded.gpuShare === undefined ? {} : { gpuShare: loaded.gpuShare }),
    ...(loadMs === undefined ? {} : { loadMs })
  }
}
