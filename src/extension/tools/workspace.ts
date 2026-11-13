import { ToolSpec } from "./protocol"

export interface ToolResult {
  output: string
  summary: string
  failed?: boolean
  final?: boolean
  preface?: string
  digest?: string
}

export interface ToolContext {
  signal?: AbortSignal
  roomChars?: number
}

export interface Tool extends ToolSpec {
  run(args: Record<string, string>, context?: ToolContext): Promise<ToolResult>
}

export interface EditOutcome {
  ok: boolean
  message: string
  pending?: boolean
  newErrors?: number
}
