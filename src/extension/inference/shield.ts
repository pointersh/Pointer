import { logger } from "../../common/logger"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import {
  describeReport,
  SecretShield,
  ShieldReport,
  withheldCount
} from "../../common/secret-shield"
import { PointerProvider } from "../../common/types"

import { ChatMessage, InferenceClient, InferenceOptions } from "./types"

export type SecretShieldMode = "offMachine" | "always" | "off"

export const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\])$/i

export const leavesMachine = (provider: PointerProvider): boolean => {
  if (HOSTED_PROVIDERS.includes(provider.provider)) return true
  const host = (provider.apiHostname || "localhost").trim()
  return !LOOPBACK.test(host)
}

export const shouldShield = (provider: PointerProvider, mode: SecretShieldMode) =>
  mode === "always" || (mode === "offMachine" && leavesMachine(provider))

export const mapJsonStrings = (json: string, change: (text: string) => string): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return change(json)
  }
  const walk = (value: unknown): unknown =>
    typeof value === "string"
      ? change(value)
      : Array.isArray(value)
        ? value.map(walk)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]))
          : value
  return JSON.stringify(walk(parsed))
}

type CallsMessage = { tool_calls?: { function: { name: string; arguments: string } }[] }

const redactToolCalls = (shield: SecretShield, message: ChatMessage): ChatMessage => {
  const calls = (message as CallsMessage).tool_calls
  if (!Array.isArray(calls) || !calls.length) return message
  return {
    ...message,
    tool_calls: calls.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: mapJsonStrings(call.function.arguments, (text) => shield.redact(text))
      }
    }))
  } as ChatMessage
}

const redactMessages = (shield: SecretShield, messages: ChatMessage[]): ChatMessage[] =>
  messages.map((original) => {
    const message = redactToolCalls(shield, original)
    if (typeof message.content === "string") {
      return { ...message, content: shield.redact(message.content) }
    }
    if (!Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "text" ? { ...part, text: shield.redact(part.text) } : part
      )
    } as ChatMessage
  })

const redactFimContext = (
  shield: SecretShield,
  context: import("./types").FimStructuredContext | undefined
) =>
  context
    ? {
        ...context,
        prefix: shield.redact(context.prefix),
        suffix: shield.redact(context.suffix),
        files: context.files?.map((file) => ({
          ...file,
          text: shield.redact(file.text)
        }))
      }
    : undefined

const tell = (
  shield: SecretShield,
  what: string,
  provider: PointerProvider,
  options?: InferenceOptions
) => {
  if (!shield.withheld) return
  const report = shield.report()
  logger.info(
    `Secret shield: withheld ${withheldCount(report)} from ${provider.label} (${what}): ${describeReport(report)}`
  )
  options?.onShield?.(report)
}

export const shieldClient = (
  client: InferenceClient,
  provider: PointerProvider
): InferenceClient => ({
  ...client,
  fim: (request, options) => {
    const shield = new SecretShield()
    const shielded = {
      ...request,
      prompt: shield.redact(request.prompt),
      prefix: request.prefix === undefined ? undefined : shield.redact(request.prefix),
      suffix: request.suffix === undefined ? undefined : shield.redact(request.suffix),
      context: redactFimContext(shield, request.context),
      messages: request.messages && redactMessages(shield, request.messages)
    }
    tell(shield, "completion", provider, options)
    const chunks = client.fim(shielded, options)
    if (!shield.withheld) return chunks
    return (async function* () {
      const restore = shield.restoreStream()
      for await (const chunk of chunks) {
        const text = restore.push(chunk.text)
        if (text || chunk.usage) yield { ...chunk, text }
      }
      const rest = restore.flush()
      if (rest) yield { text: rest }
    })()
  },
  chat: (request, options) => {
    const shield = new SecretShield()
    const shielded = { ...request, messages: redactMessages(shield, request.messages) }
    tell(shield, "chat", provider, options)
    const chunks = client.chat(shielded, options)
    if (!shield.withheld) return chunks
    return (async function* () {
      const restore = shield.restoreStream()
      for await (const chunk of chunks) {
        const content = restore.push(chunk.content)
        const toolCalls = chunk.toolCalls?.map((call) => ({
          ...call,
          arguments: mapJsonStrings(call.arguments, (text) => shield.restore(text))
        }))
        if (content || chunk.usage || chunk.reasoning || chunk.finishReason || toolCalls) {
          yield { ...chunk, content, ...(toolCalls ? { toolCalls } : {}) }
        }
      }
      const rest = restore.flush()
      if (rest) yield { content: rest }
    })()
  },
  embeddings: (request, options) => {
    const shield = new SecretShield()
    const input = Array.isArray(request.input)
      ? request.input.map((text) => shield.redact(text))
      : shield.redact(request.input)
    tell(shield, "embeddings", provider, options)
    return client.embeddings({ ...request, input }, options)
  }
})

export type { ShieldReport }
