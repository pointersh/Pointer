import { ChatCompletionMessage, MentionType, ReplyChangesView } from "../common/types"

export interface Agent {
  readonly replying: boolean
  completion(messages: ChatCompletionMessage[], mentions?: MentionType[]): Promise<unknown>
  abort(): void
  discardReply(): void
  resetConversation(): void
  answerToolApproval(id: string, run: boolean, always?: boolean): void
  stopToolStep(id: string): void
  steer(id: string, text?: string): void
  openChange(id: string, file: string): Promise<unknown>
  undoChanges(id: string, paths?: string[]): Promise<{ view?: ReplyChangesView; error?: string }>
}
