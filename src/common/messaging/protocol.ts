import { EVENT_NAME } from "../constants"
import type {
AnyContextItem,
ChatCompletionMessage,
ContextItem,LanguageType,
MentionType,ReplyChangesView,
ThemeType,
ToolStepView
} from "../types"

export interface Channel<Payload = void, Reply = never> {
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

export interface ChatRequest {
  messages: ChatCompletionMessage[]
  mentions: MentionType[]
  conversationId?: string
}

export interface ConfigValue<T = unknown> {
  key: string
  value: T
}

export interface ProviderTestResult {
  success: boolean
  error?: string
  latencyMs?: number
  sample?: string
}

export interface WorkspaceHitSummary {
  path: string
  startLine: number
  endLine: number
  score: number
  content: string
  kind?: "imports" | "team"
}

export interface WorkspaceNearMiss {
  path: string
  startLine: number
  endLine: number
  score: number
}

export type WorkspaceSearchStage =
  | "unavailable"
  | "embedding"
  | "retrieving"
  | "reranking"
  | "done"
  | "empty"

export interface WorkspaceSearchReport {
  stage: WorkspaceSearchStage
  query: string
  threshold: number
  candidates?: number
  hits: WorkspaceHitSummary[]
  nearMisses: WorkspaceNearMiss[]
  elapsedMs?: number
  note?: string
}

export interface NewDocumentRequest {
  content: string
  language?: string
}

export interface ClientEvents {
  [EVENT_NAME.pointerAcceptSolution]: Channel<string>
  [EVENT_NAME.pointerChatMessage]: Channel<ChatRequest>
  [EVENT_NAME.pointerFileListRequest]: Channel<void, string[]>
  [EVENT_NAME.pointerGetConfigValue]: Channel<{ key: string }, ConfigValue>
  [EVENT_NAME.pointerGetContextItems]: Channel
  [EVENT_NAME.pointerGetWorkspaceContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.pointerGlobalContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.pointerNewConversation]: Channel
  [EVENT_NAME.pointerNewDocument]: Channel<NewDocumentRequest>
  [EVENT_NAME.pointerNotification]: Channel<string>
  [EVENT_NAME.pointerOpenFile]: Channel<string | FileLocation>
  [EVENT_NAME.pointerRemoveContextItem]: Channel<string>
  [EVENT_NAME.pointerRunInTerminal]: Channel<string>
  [EVENT_NAME.pointerInsertAtCursor]: Channel<string>
  [EVENT_NAME.pointerSendLanguage]: Channel<void, LanguageType>
  [EVENT_NAME.pointerSendTheme]: Channel<void, ThemeType>
  [EVENT_NAME.pointerSessionContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.pointerSetConfigValue]: Channel<ConfigValue>
  [EVENT_NAME.pointerSetGlobalContext]: Channel<ContextValue>
  [EVENT_NAME.pointerSetSessionContext]: Channel<ContextValue>
  [EVENT_NAME.pointerSetWorkspaceContext]: Channel<ContextValue>
  [EVENT_NAME.pointerSidebarReady]: Channel
  [EVENT_NAME.pointerStopGeneration]: Channel
  [EVENT_NAME.pointerSymbolSearch]: Channel<{ query: string }, ContextItem[]>
  [EVENT_NAME.pointerTextSelection]: Channel<void, string>
  [EVENT_NAME.pointerToolApproval]: Channel<{ id: string; run: boolean; always?: boolean }>
  [EVENT_NAME.pointerToolStop]: Channel<{ id: string }>
  [EVENT_NAME.pointerSteer]: Channel<{ id: string; text?: string }>
  [EVENT_NAME.pointerOpenAgentSettings]: Channel
  [EVENT_NAME.pointerOpenChange]: Channel<{ id: string; path: string }>
  [EVENT_NAME.pointerUndoChanges]: Channel<{ id: string; paths?: string[] }, { view?: ReplyChangesView; error?: string }>
}

export interface ServerEvents {
  [EVENT_NAME.pointerAddMessage]: ChatCompletionMessage | undefined
  [EVENT_NAME.pointerGetConfigValue]: ConfigValue
  [EVENT_NAME.pointerGetWorkspaceContext]: ContextValue
  [EVENT_NAME.pointerGlobalContext]: ContextValue
  [EVENT_NAME.pointerNewConversation]: void
  [EVENT_NAME.pointerExportConversation]: void
  [EVENT_NAME.pointerOnCompletion]: ChatCompletionMessage
  [EVENT_NAME.pointerOnLoading]: void
  [EVENT_NAME.pointerSendLanguage]: LanguageType
  [EVENT_NAME.pointerSendLoader]: string
  [EVENT_NAME.pointerSendTheme]: ThemeType
  [EVENT_NAME.pointerSessionContext]: ContextValue
  [EVENT_NAME.pointerSetTab]: string
  [EVENT_NAME.pointerStopGeneration]: void
  [EVENT_NAME.pointerTextSelection]: string
  [EVENT_NAME.pointerUpdateContextItems]: AnyContextItem[]
  [EVENT_NAME.pointerWorkspaceSearch]: WorkspaceSearchReport
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

type EveryName =
  | (typeof EVENT_NAME)[keyof typeof EVENT_NAME]

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

export type _NamesAreDeclared = Assert<
  Extends<ClientEventName | ServerEventName, EveryName>
>
export type _NamesAreUsed = Assert<
  Extends<EveryName, ClientEventName | ServerEventName>
>

export type _RepliesMatchBroadcasts = Assert<
  {
    [K in ClientEventName & ServerEventName]: [ReplyOf<K>] extends [never]
      ? true
      : Extends<ReplyOf<K>, ServerEvents[K]>
  }[ClientEventName & ServerEventName] extends true
    ? true
    : false
>
