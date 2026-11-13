import { v4 as uuidv4 } from "uuid"
import { workspace } from "vscode"

import { API_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "../../common/constants"
import { logger } from "../../common/logger"
import {
  candidateList,
  dedupeServers,
  DiscoveredServer,
  LocalServerCandidate,
  providersForServer
} from "../../common/provider-discovery"
import { PointerProvider } from "../../common/types"

import { listProviderModels } from "./probe"
import { ProviderStore } from "./store"

const configuredOllama = (): LocalServerCandidate => {
  const config = workspace.getConfiguration("pointer")
  const hostname = config.get<string>("ollamaHostname") || "localhost"
  return {
    provider: API_PROVIDERS.Ollama,
    apiHostname: hostname === "0.0.0.0" ? "localhost" : hostname,
    apiPort: config.get<number>("ollamaApiPort") || 11434,
    apiProtocol: config.get<boolean>("ollamaUseTls") ? "https" : "http"
  }
}

const asChatDraft = (candidate: LocalServerCandidate): PointerProvider => ({
  id: "",
  label: "",
  modelName: "",
  type: "chat",
  apiPath: "",
  apiKey: "",
  ...candidate
})

const probe = async (
  candidate: LocalServerCandidate
): Promise<DiscoveredServer | undefined> => {
  const { models } = await listProviderModels(asChatDraft(candidate))
  if (models.length === 0) return undefined
  return {
    ...candidate,
    label: PROVIDER_DISPLAY_NAMES[candidate.provider] || candidate.provider,
    models
  }
}

export const discoverLocalServers = async (
  extras: LocalServerCandidate[] = [configuredOllama()]
): Promise<DiscoveredServer[]> => {
  const candidates = candidateList(extras)
  const results = await Promise.all(
    candidates.map((candidate) => probe(candidate).catch(() => undefined))
  )
  const found = dedupeServers(
    results.filter((server): server is DiscoveredServer => !!server)
  )
  logger.info(
    found.length
      ? `Found local model servers: ${found
          .map((s) => `${s.label} (${s.models.length} models)`)
          .join(", ")}`
      : "No local model server answered."
  )
  return found
}

export const applyDiscoveredServer = async (
  store: ProviderStore,
  server: DiscoveredServer
): Promise<PointerProvider[]> => {
  const providers = providersForServer(server, uuidv4)
  if (providers.length) await store.addAll(providers)
  return providers
}
