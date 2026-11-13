import { ChatCompletionMessage } from "../common/types"

export interface TextModel {
  readonly name: string
  stream(messages: ChatCompletionMessage[], signal: AbortSignal): AsyncIterable<string>
}

let current: TextModel | undefined

export const textModel = () => current
