import { deadline } from "../../common/deadline"
import {
  ProviderModelList,
  ProviderTestResult
} from "../../common/messaging/protocol"
import { usesEndpoint } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"
import { InferenceClient, readText, resolveInferenceProvider } from "../inference"

import { describeProviderErrorPlain } from "./errors"

const PROBE_TIMEOUT_MS = 20_000

const FIM_PROBE_PROMPT = "def add(a, b):\n    return"
const EMBED_PROBE_INPUT = "hello"


const testChat = (
  client: InferenceClient,
  provider: PointerProvider,
  signal: AbortSignal
): Promise<string> =>
  readText(
    client.chat(
      {
        model: provider.modelName,
        messages: [{ role: "user", content: "Say hi." }],
        maxTokens: 8
      },
      { signal }
    )
  )

const testFim = async (
  client: InferenceClient,
  provider: PointerProvider,
  signal: AbortSignal
): Promise<string> => {
  const chunks = client.fim(
    { model: provider.modelName, prompt: FIM_PROBE_PROMPT, maxTokens: 8, temperature: 0 },
    { signal }
  )
  for await (const chunk of chunks) {
    if (chunk.text) return chunk.text
  }
  return ""
}

const testEmbedding = async (
  client: InferenceClient,
  provider: PointerProvider,
  signal: AbortSignal
): Promise<string> => {
  const { vectors } = await client.embeddings(
    { model: provider.modelName, input: EMBED_PROBE_INPUT },
    { signal }
  )
  return `${vectors[0].length} dimensions`
}

export const testProvider = async (
  provider: PointerProvider,
  timeoutMs = PROBE_TIMEOUT_MS,
  parentSignal?: AbortSignal
): Promise<ProviderTestResult> => {
  const started = Date.now()
  const { signal, done } = deadline(timeoutMs, { parent: parentSignal })
  try {
    const client = resolveInferenceProvider(provider)
    let sample: string
    switch (provider.type) {
      case "fim":
        sample = await testFim(client, provider, signal)
        break
      case "embedding":
        sample = await testEmbedding(client, provider, signal)
        break
      default:
        sample = await testChat(client, provider, signal)
    }
    const latencyMs = Date.now() - started
    return {
      success: true,
      latencyMs,
      sample: sample.trim().slice(0, 60)
    }
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - started,
      error: describeProviderErrorPlain(error, provider)
    }
  } finally {
    done()
  }
}


export const listProviderModels = async (
  provider: PointerProvider,
  signal?: AbortSignal
): Promise<ProviderModelList> => {
  if (usesEndpoint(provider.provider, provider.type) && !provider.apiHostname) {
    return { models: [], error: "No hostname set." }
  }
  try {
    const models = await resolveInferenceProvider(provider).models({ signal })
    const labels = Object.fromEntries(
      models
        .filter((model) => model.name && model.name !== model.id)
        .map((model) => [model.id, model.name])
    )
    return models.length
      ? {
          models: models.map((model) => model.id),
          ...(Object.keys(labels).length ? { labels } : {})
        }
      : { models: [], error: "The server did not list any models." }
  } catch (error) {
    return { models: [], error: describeProviderErrorPlain(error, provider) }
  }
}
