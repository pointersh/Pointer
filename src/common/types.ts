import { ReactNode } from "react"
import { ChatCompletionMessageParam } from "fluency.js"
import { InlineCompletionItem, InlineCompletionList } from "vscode"

import type { WorkspaceSearchReport } from "./messaging/protocol"
import { ALL_BRACKETS } from "./constants"
import { CodeLanguageDetails } from "./languages"

export interface PrefixSuffix {
  prefix: string
  suffix: string
}

export interface LanguageType {
  language: CodeLanguageDetails
  languageId: string | undefined
}

export interface ClientMessage<
  T = string | boolean | ChatCompletionMessage[],
  Y = unknown
> {
  data?: T
  meta?: Y
  type?: string
  key?: string
}

export type ClientMessageWithData = ClientMessage<string | boolean> &
  ClientMessage<ChatCompletionMessage[]> &
  ClientMessage<GithubPullRequestMessage>

export interface ServerMessage<T = unknown> {
  type: string
  data: T
}

export interface GithubPullRequestMessage {
  owner: string
  repo: string
  number: number
}

export interface ImageAttachment {
  data: string
  type: string
  id?: string
}

export type ChatCompletionMessage = ChatCompletionMessageParam & {
  id?: string
  images?: ImageAttachment[] | string[]
  context?: WorkspaceSearchReport
  prompt?: string
  meta?: ReplyMeta
  toolSteps?: ToolStepView[]
  toolNotes?: string
  changes?: ReplyChangesView
}

export interface FileChangeView {
  path: string
  status: "modified" | "created" | "deleted"
  added: number
  removed: number
  undone?: boolean
  noUndo?: boolean
}

export interface ReplyChangesView {
  id: string
  files: FileChangeView[]
}

export interface ToolStepView {
  id: string
  name: string
  summary: string
  args?: Record<string, string>
  output?: string
  status: "running" | "waiting" | "done" | "failed" | "skipped" | "stopped"
  command?: string
  approval?: "command" | "change"
  at?: number
  stoppable?: boolean
  noAlways?: boolean
  mcpTool?: string
  said?: boolean
}

export interface ReplyMeta {
  model?: string
  provider?: string
  durationMs?: number
  completionTokens?: number
  promptTokens?: number
  contextWindow?: number
  stopped?: boolean
  outOfSteps?: boolean
  withheld?: { kind: string; label: string; count: number }[]
  instructions?: string[]
}

export interface Conversation {
  id?: string
  title?: string
  messages: ChatCompletionMessage[]
  pinnedTitle?: boolean
  updatedAt?: number
}

export const Theme = {
  Light: "Light",
  Dark: "Dark",
  Contrast: "Contrast"
} as const

export interface DefaultTemplate {
  systemMessage?: string
}

export interface TemplateData
  extends Record<string, string | undefined | null> {
  code?: string
  systemMessage?: string
  language?: string
  osName?: string
  defaultShell?: string | null
  homedir?: string
  cwd?: string
}

export interface FimTemplateData extends Record<string, string | undefined> {
  context: string
  fileName: string
  prefix: string
  suffix: string
  systemMessage?: string
}

export interface ChatTemplateData {
  systemMessage?: string
  role: string
  messages: ChatCompletionMessage[]
  code: string
  language?: string
}

export type ThemeType = (typeof Theme)[keyof typeof Theme]

export interface FimContextFile {
  name: string
  text: string
}

export interface FimPromptTemplate {
  contextFiles: FimContextFile[]
  header: string
  prefixSuffix: PrefixSuffix
  language?: string
  fileName: string
  repoName: string
}

export interface ApiProviders {
  [key: string]: { fimApiPath: string; chatApiPath: string; port: number }
}

export type Bracket = (typeof ALL_BRACKETS)[number]

export interface UiTabs {
  [key: string]: JSX.Element
}

export interface ApiModel {
  parent_model: string
  format: string
  family: string
  parameter_size: string
  digest: string
  model: string
  modified_at: string
  name: string
  size: number
}

export interface ApiModels {
  models: ApiModel[]
}

export interface ModelCatalogueEntry {
  models: string[]
  supportsStreaming?: boolean | string[]
}

export type ModelCatalogue = Record<string, ModelCatalogueEntry>

export type ResolvedInlineCompletion =
  | InlineCompletionItem[]
  | InlineCompletionList
  | PromiseLike<
      InlineCompletionItem[] | InlineCompletionList | null | undefined
    >
  | null
  | undefined

export interface InteractionItem {
  keyStrokes: number | null | undefined
  lastVisited: number
  name: string | null | undefined
  sessionLength: number
  visits: number | null | undefined
  isOpen: boolean
  relevanceScore?: number | null | undefined
  activeLines: {
    line: number
    character: number
  }[]
}

export interface PointerProvider {
  apiHostname?: string
  apiKey?: string
  apiPath?: string
  apiPort?: number
  apiProtocol?: string
  features?: string[]
  id: string
  label: string
  logo?: ReactNode
  modelName: string
  provider: string
  type: string
}

export interface ChunkOptions {
  minSize: number
  maxSize: number
  overlap: number
}

export type Embedding = {
  embeddings: [number[]]
}

export type EmbeddedDocument = {
  content: string
  vector: number[] | undefined
  file: string
}

export type CategoryType =
  | "files"
  | "workspace"
  | "problems"
  | "git"
  | "terminal"
  | "symbols"
  | "selection"

export interface ContextItem {
  id: string;
  category: CategoryType;
  name: string;
  path: string;
}

export interface SelectionContextItem extends ContextItem {
  content: string;
  selectionRange: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

export type AnyContextItem = ContextItem | SelectionContextItem;

export interface MentionType {
  name: string
  path: string
}

export interface GitHubPr {
  number: number
  title: string
  html_url: string
  draft?: boolean
  updated_at?: string
  user?: { login: string }
  head?: { ref: string }
}

export interface LMSEmbeddingItem {
  object: string
  embedding: number[]
  index: number
}

export interface LMSEmbeddingUsage {
  prompt_tokens: number
  total_tokens: number
}

export interface LMStudioEmbedding {
  object: string
  data: LMSEmbeddingItem[]
  model: string
  usage: LMSEmbeddingUsage
}

export interface ContextFile {
  name: string;
  path: string;
}
