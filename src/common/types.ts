import { ReactNode } from "react"

import { CodeLanguageDetails } from "./languages"

export interface LanguageType {
  language: CodeLanguageDetails
  languageId: string | undefined
}

interface ChatCompletionMessageParam {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  name?: string
  tool_call_id?: string
}

export type ChatCompletionMessage = ChatCompletionMessageParam & {
  id?: string
  prompt?: string
  meta?: ReplyMeta
  toolSteps?: ToolStepView[]
  toolNotes?: string
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
  modelCalls?: number
  contextWindow?: number
  stopped?: boolean
  thoughtSeconds?: number
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

export type ThemeType = (typeof Theme)[keyof typeof Theme]

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

type CategoryType =
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
