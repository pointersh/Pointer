import {
  CONVERSATION_EVENT_NAME,
  EMBEDDING_EVENT_NAME,
  EVENT_NAME,
  PROVIDER_EVENT_NAME
} from "../constants"
import type { ModelStatus, StarterKind } from "../model-status"
import type { DiscoveredServer } from "../provider-discovery"
import type {
  AnyContextItem,
  ChatCompletionMessage,
  ContextItem,
  Conversation,
  LanguageType,
  MentionType,
  ModelCatalogue,
  ReplyChangesView,
  ThemeType,
  ToolStepView,
  PointerProvider
} from "../types"

/**
 * A single channel in the protocol.
 *
 * `Payload` is what the sender puts on the wire. `Reply` is what comes back;
 * `never` marks the channel as fire-and-forget, which makes `request()` on it
 * a compile error rather than a promise that hangs forever.
 */
export interface Channel<Payload = void, Reply = never> {
  payload: Payload
  reply: Reply
}

/** A file to open, optionally scrolled to a range (zero-based, inclusive). */
export interface FileLocation {
  path: string
  startLine?: number
  endLine?: number
}

/** Reading and writing a value in one of the extension's storage scopes. */
export interface ContextValue<T = unknown> {
  key: string
  value: T
}

export interface ChatRequest {
  messages: ChatCompletionMessage[]
  /** Files/symbols the user @-mentioned in the composer. */
  mentions: MentionType[]
  conversationId?: string
}

export interface ConfigValue<T = unknown> {
  key: string
  value: T
}

/** The outcome of one live request against a provider. */
export interface ProviderTestResult {
  success: boolean
  /** A readable explanation of the failure, from `describeProviderError`. */
  error?: string
  /** Round-trip time of the probe when it succeeded. */
  latencyMs?: number
  /** What came back, e.g. the first few tokens, to show the model is alive. */
  sample?: string
}

/** Models a provider's endpoint says it serves. */
export interface ProviderModelList {
  models: string[]
  /** Optional human-facing names keyed by the callable model id. */
  labels?: Record<string, string>
  /** Set when the endpoint could not be listed; `models` is then empty. */
  error?: string
}

/** Reply to add/update: either the stored provider or the field errors. */
export interface ProviderSaveResult {
  success: boolean
  provider?: PointerProvider
  errors?: Partial<Record<keyof PointerProvider, string>>
}

/** What the embeddings tab shows about the workspace index. */
export interface EmbeddingStatus {
  indexed: boolean
  files: number
  chunks: number
  /** Unix ms of the last completed index run. */
  updatedAt?: number
  /** The embedding model the index was built with. */
  model?: string
  /** The model the active embedding provider uses now. */
  activeModel?: string
  /** The two differ: search will be wrong until the index is rebuilt. */
  modelChanged: boolean
  running: boolean
  workspace?: string
}

/** Live progress of an index run, pushed as files are processed. */
/** One chunk the workspace search handed to the model, as the chat shows it. */
export interface WorkspaceHitSummary {
  /** Workspace-relative path. */
  path: string
  /** Zero-based, inclusive. */
  startLine: number
  endLine: number
  /** Reranker probability that the chunk answers the question, 0..1. */
  score: number
  /** The chunk itself, so the chat can show it without another round trip. */
  content: string
  /** An imports block added under another hit from the file, not a match. */
  kind?: "imports" | "team"
}

/** A candidate that was scored but fell under the threshold. */
export interface WorkspaceNearMiss {
  path: string
  startLine: number
  endLine: number
  score: number
}

export type WorkspaceSearchStage =
  /** `@workspace` was asked for but there is no index to search. */
  | "unavailable"
  | "embedding"
  | "retrieving"
  | "reranking"
  /** Finished with at least one hit. */
  | "done"
  /** Finished; nothing scored above the threshold. */
  | "empty"

/**
 * What the workspace search is doing for the message being answered, and
 * what it found. Pushed once per stage so the chat can narrate the search
 * as it runs, then kept with the reply so the sources stay visible.
 */
export interface WorkspaceSearchReport {
  stage: WorkspaceSearchStage
  /** The question as searched, mentions stripped. */
  query: string
  /** Minimum reranker score a chunk needed. */
  threshold: number
  /** Fused candidates that went to the reranker, once known. */
  candidates?: number
  hits: WorkspaceHitSummary[]
  /** The best candidates that did not make the cut, highest first. */
  nearMisses: WorkspaceNearMiss[]
  /** Set once the search is over. */
  elapsedMs?: number
  /** Something worth telling the user: the embedding server was down, etc. */
  note?: string
}

export interface EmbeddingProgress {
  running: boolean
  phase: "scanning" | "embedding" | "finishing"
  /** Files embedded so far, of those that changed. */
  processed: number
  total: number
  /** Files in flight right now, for the status line. */
  currentFiles: string[]
  startedAt?: number
  /** Set when the run stopped because of a failure. */
  error?: string
  /** Set when the run was cancelled by the user. */
  cancelled?: boolean
}

export interface ConversationRename {
  id: string
  title: string
}

/** A code block sent to a fresh untitled editor. */
export interface NewDocumentRequest {
  content: string
  /** Fence language as written in the markdown (`ts`, `bash`, ...). */
  language?: string
}

/* -------------------------------------------------------------------------- */
/*  webview  ->  extension                                                    */
/* -------------------------------------------------------------------------- */

export interface ClientEvents {
  [EVENT_NAME.pointerAcceptSolution]: Channel<string>
  [EVENT_NAME.pointerChatMessage]: Channel<ChatRequest>
  [EVENT_NAME.pointerClickSuggestion]: Channel<string>
  /**
   * The rest of the message being typed, as the chat model guesses it from
   * the last few turns; empty when it has no good guess.
   */
  [EVENT_NAME.pointerEditDefaultTemplates]: Channel
  [EVENT_NAME.pointerFileListRequest]: Channel<void, string[]>
  [EVENT_NAME.pointerGetConfigValue]: Channel<{ key: string }, ConfigValue>
  [EVENT_NAME.pointerGetContextItems]: Channel
  [EVENT_NAME.pointerGetModels]: Channel<void, ModelCatalogue>
  /** Where the chat model runs, whether it is loaded and how much it holds. */
  [EVENT_NAME.pointerModelStatus]: Channel<void, ModelStatus | null>
  /** Loads the chat model on its local server; answers with its status once it is. */
  [EVENT_NAME.pointerWarmModel]: Channel<void, ModelStatus | null>
  /** A first question about the open file or selection, from the empty chat. */
  [EVENT_NAME.pointerStarter]: Channel<StarterKind>
  [EVENT_NAME.pointerGetWorkspaceContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.pointerGlobalContext]: Channel<{ key: string }, ContextValue>
  [EVENT_NAME.pointerHideBackButton]: Channel
  [EVENT_NAME.pointerListTemplates]: Channel<void, string[]>
  [EVENT_NAME.pointerNewConversation]: Channel
  [EVENT_NAME.pointerNewDocument]: Channel<NewDocumentRequest>
  [EVENT_NAME.pointerNotification]: Channel<string>
  [EVENT_NAME.pointerOpenFile]: Channel<string | FileLocation>
  [EVENT_NAME.pointerOpenProviders]: Channel
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
  /**
   * The user's answer to a command waiting in the tool steps; `always`
   * runs that same command without asking from then on.
   */
  [EVENT_NAME.pointerToolApproval]: Channel<{ id: string; run: boolean; always?: boolean }>
  /** Stop the command a running tool step is waiting on, and only that. */
  [EVENT_NAME.pointerToolStop]: Channel<{ id: string }>
  /**
   * A message queued while an agent reply works, offered for the model to
   * read at its next step; without `text`, the offer is taken back. One
   * the model reads comes back as a `said` tool step with the id
   * `said.<id>`; one it never reached stays queued.
   */
  [EVENT_NAME.pointerSteer]: Channel<{ id: string; text?: string }>
  /** The agent's settings in VS Code's settings editor. */
  [EVENT_NAME.pointerOpenAgentSettings]: Channel
  /** A file an agent reply changed, beside what it was before the reply. */
  [EVENT_NAME.pointerOpenChange]: Channel<{ id: string; path: string }>
  /**
   * Put an agent reply's changed files (all, or `paths`) back as they
   * were; answers with the changes as they then stand, or why not.
   */
  [EVENT_NAME.pointerUndoChanges]: Channel<{ id: string; paths?: string[] }, { view?: ReplyChangesView; error?: string }>

  [CONVERSATION_EVENT_NAME.clearAllConversations]: Channel
  [CONVERSATION_EVENT_NAME.getActiveConversation]: Channel
  [CONVERSATION_EVENT_NAME.getConversations]: Channel
  [CONVERSATION_EVENT_NAME.removeConversation]: Channel<Conversation>
  [CONVERSATION_EVENT_NAME.renameConversation]: Channel<ConversationRename>
  [CONVERSATION_EVENT_NAME.saveConversation]: Channel<Conversation | undefined>
  [CONVERSATION_EVENT_NAME.setActiveConversation]: Channel<
    Conversation | undefined
  >

  [EMBEDDING_EVENT_NAME.cancel]: Channel
  [EMBEDDING_EVENT_NAME.embed]: Channel
  [EMBEDDING_EVENT_NAME.rebuild]: Channel
  [EMBEDDING_EVENT_NAME.getStatus]: Channel<void, EmbeddingStatus>

  [PROVIDER_EVENT_NAME.addProvider]: Channel<PointerProvider, ProviderSaveResult>
  [PROVIDER_EVENT_NAME.copyProvider]: Channel<PointerProvider>
  [PROVIDER_EVENT_NAME.discoverProviders]: Channel<void, DiscoveredServer[]>
  [PROVIDER_EVENT_NAME.exportProviders]: Channel
  [PROVIDER_EVENT_NAME.getActiveChatProvider]: Channel
  [PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider]: Channel
  [PROVIDER_EVENT_NAME.getAllProviders]: Channel
  [PROVIDER_EVENT_NAME.importProviders]: Channel
  [PROVIDER_EVENT_NAME.listProviderModels]: Channel<
    PointerProvider,
    ProviderModelList
  >
  [PROVIDER_EVENT_NAME.removeProvider]: Channel<PointerProvider>
  [PROVIDER_EVENT_NAME.resetProvidersToDefaults]: Channel
  [PROVIDER_EVENT_NAME.setActiveChatProvider]: Channel<PointerProvider>
  [PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider]: Channel<PointerProvider>
  [PROVIDER_EVENT_NAME.testProvider]: Channel<PointerProvider, ProviderTestResult>
  [PROVIDER_EVENT_NAME.updateProvider]: Channel<
    PointerProvider,
    ProviderSaveResult
  >
  [PROVIDER_EVENT_NAME.useDiscoveredServer]: Channel<
    DiscoveredServer,
    PointerProvider[]
  >

}

/* -------------------------------------------------------------------------- */
/*  extension  ->  webview                                                    */
/* -------------------------------------------------------------------------- */

export interface ServerEvents {
  [EVENT_NAME.pointerAddMessage]: ChatCompletionMessage | undefined
  [EVENT_NAME.pointerGetConfigValue]: ConfigValue
  [EVENT_NAME.pointerGetModels]: ModelCatalogue
  [EVENT_NAME.pointerGetWorkspaceContext]: ContextValue
  [EVENT_NAME.pointerGlobalContext]: ContextValue
  [EVENT_NAME.pointerListTemplates]: string[]
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
  /** The tool steps of the reply being written, whole, each time one changes. */
  [EVENT_NAME.pointerToolSteps]: ToolStepView[]

  [CONVERSATION_EVENT_NAME.getConversations]: Record<string, Conversation>
  [CONVERSATION_EVENT_NAME.setActiveConversation]: Conversation | undefined

  [EMBEDDING_EVENT_NAME.getStatus]: EmbeddingStatus
  [EMBEDDING_EVENT_NAME.progress]: EmbeddingProgress

  [PROVIDER_EVENT_NAME.focusProviderTab]: string
  [PROVIDER_EVENT_NAME.getActiveChatProvider]: PointerProvider | undefined
  [PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider]: PointerProvider | undefined
  [PROVIDER_EVENT_NAME.getAllProviders]: Record<string, PointerProvider>
}

/* -------------------------------------------------------------------------- */
/*  Derived types                                                             */
/* -------------------------------------------------------------------------- */

export type ClientEventName = keyof ClientEvents
export type ServerEventName = keyof ServerEvents

export type PayloadOf<K extends ClientEventName> = ClientEvents[K]["payload"]
export type ReplyOf<K extends ClientEventName> = ClientEvents[K]["reply"]
export type ServerPayloadOf<K extends ServerEventName> = ServerEvents[K]

/** The subset of client channels that actually answer — see `Channel`. */
export type RequestableEvent = {
  [K in ClientEventName]: [ReplyOf<K>] extends [never] ? never : K
}[ClientEventName]

/** Channels whose payload is `void`, so the caller may omit the argument. */
export type VoidPayloadEvent = {
  [K in ClientEventName]: [PayloadOf<K>] extends [void] ? K : never
}[ClientEventName]

/* -------------------------------------------------------------------------- */
/*  Compile-time guards                                                       */
/* -------------------------------------------------------------------------- */

type EveryName =
  | (typeof EVENT_NAME)[keyof typeof EVENT_NAME]
  | (typeof CONVERSATION_EVENT_NAME)[keyof typeof CONVERSATION_EVENT_NAME]
  | (typeof EMBEDDING_EVENT_NAME)[keyof typeof EMBEDDING_EVENT_NAME]
  | (typeof PROVIDER_EVENT_NAME)[keyof typeof PROVIDER_EVENT_NAME]

/**
 * Every declared name must be used by at least one direction, and no channel
 * may invent a name that is not in the constants. Deleting a constant that is
 * still in the protocol — or adding one nobody speaks — fails the build here.
 */
type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

export type _NamesAreDeclared = Assert<
  Extends<ClientEventName | ServerEventName, EveryName>
>
export type _NamesAreUsed = Assert<
  Extends<EveryName, ClientEventName | ServerEventName>
>

/**
 * A channel that exists in both directions must agree with itself: the value
 * the extension replies with is the same value it broadcasts unprompted.
 */
export type _RepliesMatchBroadcasts = Assert<
  {
    [K in ClientEventName & ServerEventName]: [ReplyOf<K>] extends [never]
      ? true
      : Extends<ReplyOf<K>, ServerEvents[K]>
  }[ClientEventName & ServerEventName] extends true
    ? true
    : false
>
