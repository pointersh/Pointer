import { EVENT_NAME } from "../constants"
import type {
AnyContextItem,
ChatCompletionMessage,
ContextItem, MentionType, ThemeType,
ToolStepView
} from "../types"

interface Channel<Payload = void, Reply = never> {
  payload: Payload
  reply: Reply
}

export interface FileLocation {
  path: string
  startLine?: number
  endLine?: number
}

export interface ContextValue<T = unknown> {
  key: string
  value: T
}

interface ChatRequest {
  messages: ChatCompletionMessage[]
  mentions: MentionType[]
  conversationId?: string
}

export interface NewDocumentRequest {
  content: string
  language?: string
}

interface ClientEvents {
  [EVENT_NAME.pointerAcceptSolution]: Channel<string>
  [EVENT_NAME.pointerChatMessage]: Channel<ChatRequest>
  [EVENT_NAME.pointerFileListRequest]: Channel<void, string[]>
  [EVENT_NAME.pointerGetContextItems]: Channel
  [EVENT_NAME.pointerGetWorkspaceContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.pointerGlobalContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.pointerNewConversation]: Channel
  [EVENT_NAME.pointerNewDocument]: Channel<NewDocumentRequest>
  [EVENT_NAME.pointerOpenFile]: Channel<string | FileLocation>
  [EVENT_NAME.pointerRemoveContextItem]: Channel<string>
  [EVENT_NAME.pointerRunInTerminal]: Channel<string>
  [EVENT_NAME.pointerInsertAtCursor]: Channel<string>
  [EVENT_NAME.pointerModels]: Channel<{ pick?: string }, string[]>
  [EVENT_NAME.pointerSendTheme]: Channel<void, ThemeType>
  [EVENT_NAME.pointerSessionContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.pointerSetGlobalContext]: Channel<ContextValue>
  [EVENT_NAME.pointerSetSessionContext]: Channel<ContextValue>
  [EVENT_NAME.pointerSetWorkspaceContext]: Channel<ContextValue>
  [EVENT_NAME.pointerSidebarReady]: Channel
  [EVENT_NAME.pointerStopGeneration]: Channel
  [EVENT_NAME.pointerSymbolSearch]: Channel<{ query: string }, ContextItem[]>
  [EVENT_NAME.pointerTextSelection]: Channel<void, string>
  [EVENT_NAME.pointerToolApproval]: Channel<{ id: string; run: boolean; always?: boolean }>
}

interface ServerEvents {
  [EVENT_NAME.pointerAddMessage]: ChatCompletionMessage | undefined
  [EVENT_NAME.pointerGetWorkspaceContext]: ContextValue
  [EVENT_NAME.pointerGlobalContext]: ContextValue
  [EVENT_NAME.pointerNewConversation]: void
  [EVENT_NAME.pointerOnCompletion]: ChatCompletionMessage
  [EVENT_NAME.pointerSendTheme]: ThemeType
  [EVENT_NAME.pointerSessionContext]: ContextValue
  [EVENT_NAME.pointerStopGeneration]: void
  [EVENT_NAME.pointerTextSelection]: string
  [EVENT_NAME.pointerUpdateContextItems]: AnyContextItem[]
  [EVENT_NAME.pointerToolSteps]: ToolStepView[]

}

export type ClientEventName = keyof ClientEvents
export type ServerEventName = keyof ServerEvents

export type PayloadOf<K extends ClientEventName> = ClientEvents[K]["payload"]
export type ReplyOf<K extends ClientEventName> = ClientEvents[K]["reply"]
export type ServerPayloadOf<K extends ServerEventName> = ServerEvents[K]

export type RequestableEvent = {
  [K in ClientEventName]: [ReplyOf<K>] extends [never] ? never : K
}[ClientEventName]

export type VoidPayloadEvent = {
  [K in ClientEventName]: [PayloadOf<K>] extends [void] ? K : never
}[ClientEventName]
