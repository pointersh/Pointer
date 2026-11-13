import type { ShieldReport } from "../../common/secret-shield"
import { ChatCompletionMessage, FimContextFile } from "../../common/types"

export type InferenceCapability = "fim" | "chat" | "embeddings"

export const INFERENCE_CAPABILITIES: InferenceCapability[] = [
  "fim",
  "chat",
  "embeddings"
]

export interface InferenceModel {
  id: string
  name: string
  capabilities: InferenceCapability[]
  contextWindow?: number
}

export interface InferenceOptions {
  signal?: AbortSignal
  onShield?(report: ShieldReport[]): void
}

export interface FimStructuredContext {
  language?: string
  fileName?: string
  repoName?: string
  prefix: string
  suffix: string
  files?: FimContextFile[]
}

export interface FimRequest {
  model: string
  prompt: string
  prefix?: string
  suffix?: string
  context?: FimStructuredContext
  stop?: string[]
  maxTokens?: number
  temperature?: number
  keepAlive?: string | number
  messages?: ChatMessage[]
}

export interface InferenceUsage {
  promptTokens?: number
  completionTokens?: number
}

export interface FimChunk {
  text: string
  usage?: InferenceUsage
}

export type ChatMessage = ChatCompletionMessage

export interface ChatToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatToolCall {
  id: string
  name: string
  arguments: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ChatToolDefinition[]
  maxTokens?: number
  temperature?: number
  think?: boolean
  reasoningEffort?: "low" | "medium" | "high"
}

export type ChatFinishReason = "stop" | "length"

export interface ChatChunk {
  content: string
  usage?: InferenceUsage
  reasoning?: string
  finishReason?: ChatFinishReason
  toolCalls?: ChatToolCall[]
}

export interface EmbeddingRequest {
  model: string
  input: string | string[]
}

export interface EmbeddingResponse {
  vectors: number[][]
  usage?: InferenceUsage
}

export type InferenceStream<T> = AsyncIterable<T>

export interface InferenceProvider {
  readonly id: string

  capabilities(): InferenceCapability[]

  models?(options?: InferenceOptions): Promise<InferenceModel[]>

  fim?(request: FimRequest, options?: InferenceOptions): InferenceStream<FimChunk>

  chat?(
    request: ChatRequest,
    options?: InferenceOptions
  ): InferenceStream<ChatChunk>

  embeddings?(
    request: EmbeddingRequest,
    options?: InferenceOptions
  ): Promise<EmbeddingResponse>
}

export type InferenceClient = Required<InferenceProvider>
