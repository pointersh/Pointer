import { ChatCompletionMessage } from "../common/types"

export interface TextModel {
  readonly name: string
  // The fallback chain, in order; stream(..., from) starts at models[from].
  readonly models?: string[]
  stream(messages: ChatCompletionMessage[], signal: AbortSignal, from?: number): AsyncIterable<string>
}

let current: TextModel | undefined

export const setTextModel = (model: TextModel | undefined) => {
  current = model
}

export const textModel = () => current
