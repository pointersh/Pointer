import { useCallback, useEffect, useState } from "react"

import { PROVIDER_EVENT_NAME } from "../../common/constants"
import { messageOf } from "../../common/errors"
import {
  ProviderModelList,
  ProviderSaveResult,
  ProviderTestResult
} from "../../common/messaging/protocol"
import { DiscoveredServer } from "../../common/provider-discovery"
import { PROVIDER_TYPES, ProviderType } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"
import { bridge, emit, useServerEvent } from "../messaging"

export type { ProviderType }

export { PROVIDER_TYPES as OFFERED_PROVIDER_TYPES }

const failed = (error: unknown): ProviderTestResult => ({
  success: false,
  error: messageOf(error)
})

export const useProviders = () => {
  const [providers, setProviders] = useState<Record<string, PointerProvider>>({})
  const [chatProvider, setChatProvider] = useState<PointerProvider | null>(null)
  const [embeddingProvider, setEmbeddingProvider] =
    useState<PointerProvider | null>(null)
  const [ready, setReady] = useState(false)

  useServerEvent(PROVIDER_EVENT_NAME.getAllProviders, (all) => {
    setProviders(all || {})
    setReady(true)
  })
  useServerEvent(PROVIDER_EVENT_NAME.getActiveChatProvider, (provider) =>
    setChatProvider(provider || null)
  )
  useServerEvent(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider, (provider) =>
    setEmbeddingProvider(provider || null)
  )

  useEffect(() => {
    emit(PROVIDER_EVENT_NAME.getAllProviders)
    emit(PROVIDER_EVENT_NAME.getActiveChatProvider)
    emit(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider)
  }, [])

  const getProvidersByType = useCallback(
    (type: string) =>
      Object.values(providers).filter((provider) => provider.type === type),
    [providers]
  )

  const activeProviders: Record<ProviderType, PointerProvider | null> = {
    chat: chatProvider,
    embedding: embeddingProvider
  }

  const setActiveProvider = useCallback(
    (type: ProviderType, provider: PointerProvider) => {
      const channel = {
        chat: PROVIDER_EVENT_NAME.setActiveChatProvider,
        embedding: PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider
      }[type]
      emit(channel, provider)
    },
    []
  )

  return {
    activeProviders,
    chatProvider,
    ready,
    embeddingProvider,
    getProvidersByType,
    providers,
    setActiveProvider,
    copyProvider: (p: PointerProvider) =>
      emit(PROVIDER_EVENT_NAME.copyProvider, p),
    removeProvider: (p: PointerProvider) =>
      emit(PROVIDER_EVENT_NAME.removeProvider, p),
    resetProviders: () => emit(PROVIDER_EVENT_NAME.resetProvidersToDefaults),
    saveProvider: (p: PointerProvider): Promise<ProviderSaveResult> =>
      bridge.request(PROVIDER_EVENT_NAME.addProvider, p),
    updateProvider: (p: PointerProvider): Promise<ProviderSaveResult> =>
      bridge.request(PROVIDER_EVENT_NAME.updateProvider, p),
    testProvider: (p: PointerProvider): Promise<ProviderTestResult> =>
      bridge.request(PROVIDER_EVENT_NAME.testProvider, p).catch(failed),
    listModels: (p: PointerProvider): Promise<ProviderModelList> =>
      bridge
        .request(PROVIDER_EVENT_NAME.listProviderModels, p)
        .catch((error) => ({ models: [], error: failed(error).error })),
    discoverServers: (): Promise<DiscoveredServer[]> =>
      bridge.request(PROVIDER_EVENT_NAME.discoverProviders).catch(() => []),
    useDiscoveredServer: (server: DiscoveredServer): Promise<PointerProvider[]> =>
      bridge
        .request(PROVIDER_EVENT_NAME.useDiscoveredServer, server)
        .catch(() => []),
    setActiveChatProvider: (p: PointerProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveChatProvider, p),
    setActiveEmbeddingsProvider: (p: PointerProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider, p),
    triggerExportProviders: () => emit(PROVIDER_EVENT_NAME.exportProviders),
    triggerImportProviders: () => emit(PROVIDER_EVENT_NAME.importProviders)
  }
}
