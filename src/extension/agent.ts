import { ChatCompletionMessage, MentionType } from "../common/types"

export interface Agent {
  readonly replying: boolean
  completion(messages: ChatCompletionMessage[], mentions?: MentionType[]): Promise<unknown>
  abort(): void
  discardReply(): void
  resetConversation(): void
  answerToolApproval(id: string, run: boolean, always?: boolean): void
  stopToolStep(id: string): void
}
