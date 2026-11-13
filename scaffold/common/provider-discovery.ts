import {
API_PROVIDERS,PROVIDER_DISPLAY_NAMES
} from "./constants"
import { pickModelStrict } from "./model-pick"
import {
getEndpointDefaults,
PROVIDER_TYPES,
ProviderType
} from "./provider-validation"
import { PointerProvider } from "./types"

export interface LocalServerCandidate {
  provider: string
  apiHostname: string
  apiPort: number
  apiProtocol: string
}

export interface DiscoveredServer extends LocalServerCandidate {
  label: string
  models: string[]
}

export const LOCAL_SERVER_PROVIDERS: string[] = [
  API_PROVIDERS.Ollama,
  API_PROVIDERS.LMStudio,
  API_PROVIDERS.LlamaCpp,
  API_PROVIDERS.Oobabooga,
  API_PROVIDERS.LiteLLM,
  API_PROVIDERS.OpenWebUI,
  API_PROVIDERS.OpenAICompatible
]

export const DEFAULT_LOCAL_CANDIDATES: LocalServerCandidate[] =
  LOCAL_SERVER_PROVIDERS.flatMap((provider) => {
    const defaults = getEndpointDefaults(provider, "chat")
    if (!defaults?.apiHostname || !defaults.apiPort) return []
    return [
      {
        provider,
        apiHostname: defaults.apiHostname,
        apiPort: defaults.apiPort,
        apiProtocol: defaults.apiProtocol || "http"
      }
    ]
  })

const sameAddress = (a: LocalServerCandidate, b: LocalServerCandidate) =>
  a.apiHostname === b.apiHostname &&
  a.apiPort === b.apiPort &&
  a.apiProtocol === b.apiProtocol

export const candidateList = (
  extras: LocalServerCandidate[] = []
): LocalServerCandidate[] => {
  const list = DEFAULT_LOCAL_CANDIDATES.map(
    (candidate) => extras.find((extra) => sameAddress(extra, candidate)) || candidate
  )
  const fresh = extras.filter((extra) => !list.some((c) => sameAddress(c, extra)))
  return [...fresh, ...list]
}

export const dedupeServers = (servers: DiscoveredServer[]): DiscoveredServer[] =>
  servers.filter(
    (server, index) => servers.findIndex((s) => sameAddress(s, server)) === index
  )

export const describeServer = (server: DiscoveredServer) =>
  `${server.label} at ${server.apiHostname}:${server.apiPort}`

export const providersForServer = (
  server: DiscoveredServer,
  makeId: () => string
): PointerProvider[] => {
  const providers: PointerProvider[] = []
  for (const type of PROVIDER_TYPES) {
    const modelName = pickModelStrict(server.models, type)
    if (!modelName) continue
    const endpoint = getEndpointDefaults(server.provider, type)
    providers.push({
      id: makeId(),
      label: labelFor(server, type),
      modelName,
      provider: server.provider,
      type,
      apiHostname: server.apiHostname,
      apiPort: server.apiPort,
      apiProtocol: server.apiProtocol,
      apiPath: endpoint?.apiPath ?? "",
      apiKey: "",
    })
  }
  return providers
}

const labelFor = (server: DiscoveredServer, type: ProviderType) => {
  const name = PROVIDER_DISPLAY_NAMES[server.provider] || server.provider
  return type === "chat" ? name : `${name} ${type.toUpperCase()}`
}
