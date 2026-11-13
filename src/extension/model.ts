import { ChatCompletionMessage } from "../common/types"

export interface TextModel {
  readonly name: string
  stream(messages: ChatCompletionMessage[], signal: AbortSignal): AsyncIterable<string>
}

let current: TextModel | undefined

export const setTextModel = (model: TextModel | undefined) => {
  current = model
}

export const textModel = () => current
