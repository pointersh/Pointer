import { models as catalogue, TokenJS } from "fluency.js"
import {
  CompletionNonStreaming,
  CompletionStreaming,
  LLMProvider
} from "fluency.js/dist/chat"

import { API_PROVIDERS } from "../../../common/constants"
import { isOpenAICompatibleProvider } from "../../../common/provider-validation"
import { PointerProvider } from "../../../common/types"
import {
  ChatChunk,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  InferenceModel,
  InferenceOptions
} from "../types"

import { StreamResponse, usageFromResponse } from "./fim-dialects"
import { logRequest } from "./json-stream"

export const getFluencyProvider = (provider: PointerProvider): LLMProvider =>
  (isOpenAICompatibleProvider(provider.provider)
    ? API_PROVIDERS.OpenAICompatible
    : provider.provider) as LLMProvider

export const supportsStreaming = (provider: PointerProvider): boolean => {
  const entry = catalogue[provider.provider as keyof typeof catalogue]
  const streaming = entry?.supportsStreaming
  return Array.isArray(streaming) ? streaming.includes(provider.modelName) : true
}

export const flattenTextContent = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) => {
    const content = message.content as unknown
    if (!Array.isArray(content) || !content.length) return message
    const parts = content as Array<{ type?: string; text?: string }>
    if (!parts.every((part) => part && part.type === "text" && typeof part.text === "string")) return message
    return { ...message, content: parts.map((part) => part.text).join("\n") } as ChatMessage
  })

export const parsableToolArguments = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) => {
    const calls = (message as { tool_calls?: Array<{ function?: { arguments?: unknown } }> }).tool_calls
    if (!Array.isArray(calls) || !calls.length) return message
    return {
      ...message,
      tool_calls: calls.map((call) => {
        const raw = typeof call.function?.arguments === "string" ? call.function.arguments.trim() : ""
        let args = "{}"
        if (raw) {
          try {
            JSON.parse(raw)
            args = raw
          } catch {
            args = JSON.stringify({ input: raw })
          }
        }
        return { ...call, function: { ...call.function, arguments: args } }
      })
    } as ChatMessage
  })

type ChatParameters = Pick<ChatRequest, "maxTokens" | "temperature" | "think" | "tools" | "reasoningEffort">

const requestParameters = (provider: PointerProvider, request: ChatParameters) => ({
  ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  ...(request.think === false && provider.provider === API_PROVIDERS.Ollama ? { reasoning_effort: "none" as const } : {}),
  ...(request.reasoningEffort && provider.provider === API_PROVIDERS.OpenAI
    ? { reasoning_effort: request.reasoningEffort }
    : {}),
  ...(request.tools?.length
    ? {
        tools: request.tools.map((tool) => ({
          type: "function" as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters }
        }))
      }
    : {})
})

type ToolCallDelta = {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

const toolCallCollector = () => {
  const calls: { id: string; name: string; arguments: string }[] = []
  return {
    add(deltas: unknown) {
      if (!Array.isArray(deltas)) return
      for (const delta of deltas as ToolCallDelta[]) {
        const index = delta.index ?? calls.length
        const call = (calls[index] ??= { id: "", name: "", arguments: "" })
        if (delta.id) call.id = delta.id
        if (delta.function?.name) call.name += delta.function.name
        if (delta.function?.arguments) call.arguments += delta.function.arguments
      }
    },
    take(): ChatToolCall[] | undefined {
      const done = calls
        .filter((call) => call?.name)
        .map((call, i) => ({ ...call, id: call.id || `call_${i}` }))
      calls.length = 0
      return done.length ? done : undefined
    }
  }
}

const finishReasonOf = (reason: unknown): ChatFinishReason | undefined =>
  reason === "length" ? "length" : typeof reason === "string" && reason ? "stop" : undefined

const reasoningOf = (delta: unknown): string | undefined => {
  if (!delta || typeof delta !== "object") return undefined
  const part = delta as { reasoning?: unknown; reasoning_content?: unknown; thinking?: unknown }
  const text = part.reasoning ?? part.reasoning_content ?? part.thinking
  return typeof text === "string" && text ? text : undefined
}

const serverKey = (provider: PointerProvider) =>
  [provider.provider, provider.apiHostname ?? "", provider.apiPort ?? "", provider.apiPath ?? ""].join("|")

const refusedStreamOptions = new Set<string>()

const asksForUsage = (provider: PointerProvider) =>
  (provider.provider === API_PROVIDERS.OpenAI ||
    (isOpenAICompatibleProvider(provider.provider) && provider.provider !== API_PROVIDERS.Qvac)) &&
  !refusedStreamOptions.has(serverKey(provider))

const usesTools = (messages: ChatMessage[], parameters: ChatParameters) =>
  !!parameters.tools?.length ||
  messages.some(
    (message) => message.role === "tool" || !!(message as { tool_calls?: unknown[] }).tool_calls?.length
  )

const withCacheBreakpoints = (messages: ChatMessage[]): ChatMessage[] => {
  const system = messages.findIndex((message) => message.role === "system")
  const result = messages.map((message) => message.role as string).lastIndexOf("tool")
  if (system === -1 && result === -1) return messages
  return messages.map((message, index) =>
    index === system || index === result
      ? ({ ...message, cache_control: { type: "ephemeral" } } as ChatMessage)
      : message
  )
}

export const buildStreamingRequest = (
  provider: PointerProvider,
  messages: ChatMessage[],
  parameters: ChatParameters = {}
): CompletionStreaming<LLMProvider> => {
  const flat = parsableToolArguments(flattenTextContent(messages))
  return {
    messages:
      provider.provider === API_PROVIDERS.Anthropic && usesTools(messages, parameters)
        ? withCacheBreakpoints(flat)
        : flat,
    model: provider.modelName,
    stream: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: getFluencyProvider(provider) as any,
    ...(asksForUsage(provider) ? { stream_options: { include_usage: true } } : {}),
    ...requestParameters(provider, parameters)
  } as CompletionStreaming<LLMProvider>
}

export const buildBlockingRequest = (
  provider: PointerProvider,
  messages: ChatMessage[],
  parameters: ChatParameters = {}
): CompletionNonStreaming<LLMProvider> => ({
  messages: parsableToolArguments(flattenTextContent(messages.filter((m) => m.role !== "system"))),
  model: provider.modelName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: getFluencyProvider(provider) as any,
  ...requestParameters(provider, parameters)
})

export const hostedTakesTools = (providerKind: string): boolean => {
  const entry = catalogue[providerKind as keyof typeof catalogue] as
    | { supportsToolCalls?: boolean | readonly string[] }
    | undefined
  const tools = entry?.supportsToolCalls
  return tools === true || (Array.isArray(tools) && tools.length > 0)
}

export async function* fluencyChat(
  client: TokenJS,
  config: PointerProvider,
  request: ChatRequest,
  options?: InferenceOptions
): AsyncGenerator<ChatChunk> {
  const messages = request.messages
  if (supportsStreaming(config)) {
    const body = buildStreamingRequest(config, messages, request)
    logRequest(`${config.provider}/chat.completions (stream)`, body)
    const parts = await client.chat.completions.create(body).catch((error: unknown) => {
      const asked = "stream_options" in body
      if (!asked || !/stream_options|include_usage/i.test(error instanceof Error ? error.message : String(error))) {
        throw error
      }
      refusedStreamOptions.add(serverKey(config))
      return client.chat.completions.create(buildStreamingRequest(config, messages, request))
    })
    const toolCalls = toolCallCollector()
    for await (const part of parts) {
      if (options?.signal?.aborted) break
      const delta = part.choices[0]?.delta?.content
      toolCalls.add((part.choices[0]?.delta as { tool_calls?: unknown } | undefined)?.tool_calls)
      const reasoning = reasoningOf(part.choices[0]?.delta)
      const usage = usageFromResponse(part as unknown as { usage?: StreamResponse["usage"] })
      const finishReason = finishReasonOf(part.choices[0]?.finish_reason)
      const calls = finishReason ? toolCalls.take() : undefined
      const extras = {
        ...(reasoning ? { reasoning } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(calls ? { toolCalls: calls } : {})
      }
      if (usage) yield { content: delta || "", usage, ...extras }
      else if (delta) yield { content: delta, ...extras }
      else if (reasoning || finishReason) yield { content: "", ...extras }
    }
    const unfinished = toolCalls.take()
    if (unfinished) yield { content: "", toolCalls: unfinished }
    return
  }
  const body = buildBlockingRequest(config, messages, request)
  logRequest(`${config.provider}/chat.completions`, body)
  const result = await client.chat.completions.create(body)
  const content = result.choices[0]?.message?.content
  const usage = usageFromResponse(result as unknown as { usage?: StreamResponse["usage"] })
  const finishReason = finishReasonOf(result.choices[0]?.finish_reason)
  const toolCalls = toolCallCollector()
  toolCalls.add(
    ((result.choices[0]?.message as { tool_calls?: ToolCallDelta[] } | undefined)?.tool_calls ?? [])
      .map((call, index) => ({ ...call, index }))
  )
  const calls = toolCalls.take()
  const extras = { ...(finishReason ? { finishReason } : {}), ...(calls ? { toolCalls: calls } : {}) }
  if (usage) yield { content: content || "", usage, ...extras }
  else if (content || finishReason || calls) yield { content: content || "", ...extras }
}

export const hostedModels = (providerId: string): InferenceModel[] => {
  const entry = (
    catalogue as unknown as Record<string, { models?: unknown }>
  )[providerId]
  const names = Array.isArray(entry?.models)
    ? entry.models.filter((m): m is string => typeof m === "string")
    : []
  return names.map((name) => ({ id: name, name, capabilities: ["chat"] }))
}
