import { SYSTEM, USER } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"

export interface EditRequest {
  instruction: string
  code: string
  language?: string
  fileName?: string
  before?: string
  after?: string
}

export const EDIT_CONTEXT_LINES = 40
const EDIT_CONTEXT_CHARS = 6000

const EDIT_SYSTEM_PROMPT = [
  "You are an expert programmer editing code inside the user's editor.",
  "You will be given a piece of code and an instruction.",
  "Rewrite the code so that it follows the instruction.",
  "",
  "Rules:",
  "- Reply with the rewritten code only. No explanation, no commentary, no markdown fences.",
  "- Return the complete replacement for the given code, not a diff and not a fragment.",
  "- Keep everything the instruction does not ask you to change: names, style, formatting, comments.",
  "- Do not repeat the surrounding context; it is shown for reference only.",
  "- If the instruction cannot be applied, return the code unchanged."
].join("\n")

const fence = (language: string | undefined, body: string) =>
  `\`\`\`${language || ""}\n${body}\n\`\`\``

const buildEditPrompt = (request: EditRequest): string => {
  const parts: string[] = []
  if (request.fileName) parts.push(`File: ${request.fileName}`)

  const before = request.before?.trim()
  const after = request.after?.trim()
  if (before || after) {
    parts.push(
      "Surrounding code (for context only, do not include it in your reply):"
    )
    if (before) parts.push(fence(request.language, request.before || ""))
    if (before && after) parts.push("[... the code to edit goes here ...]")
    if (after) parts.push(fence(request.language, request.after || ""))
  }

  parts.push("Code to edit:")
  parts.push(fence(request.language, request.code))
  parts.push(`Instruction: ${request.instruction.trim()}`)
  parts.push("Reply with the rewritten code only.")
  return parts.join("\n\n")
}

export const buildEditMessages = (
  request: EditRequest
): ChatCompletionMessage[] => [
  { role: SYSTEM, content: EDIT_SYSTEM_PROMPT },
  { role: USER, content: buildEditPrompt(request) }
]

const stripReasoning = (text: string) =>
  text
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(think|thinking)>[\s\S]*$/i, "")

const extractEditedCode = (reply: string): string => {
  const text = stripReasoning(reply)
  const open = text.match(/(^|\n)[ \t]*```[^\n]*\n?/)
  if (!open || open.index === undefined) return text.replace(/^\s*\n/, "")

  const start = open.index + open[0].length
  const close = text.slice(start).match(/(^|\n)[ \t]*```[ \t]*(\n|$)/)
  return close?.index === undefined
    ? text.slice(start)
    : text.slice(start, start + close.index)
}

const commonIndent = (text: string): string => {
  let indent: string | undefined
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const lead = line.match(/^[ \t]*/)?.[0] ?? ""
    if (indent === undefined) {
      indent = lead
      continue
    }
    let i = 0
    while (i < indent.length && i < lead.length && indent[i] === lead[i]) i++
    indent = indent.slice(0, i)
    if (!indent) break
  }
  return indent ?? ""
}

export const matchIndentation = (edited: string, original: string): string => {
  const wanted = commonIndent(original)
  const got = commonIndent(edited)
  if (wanted === got) return edited
  return edited
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line
      const rest = line.startsWith(got) ? line.slice(got.length) : line
      return wanted + rest
    })
    .join("\n")
}

export const previewEdit = (reply: string, original: string): string =>
  matchIndentation(extractEditedCode(reply), original)

export const finalizeEdit = (reply: string, original: string): string => {
  let code = extractEditedCode(reply).replace(/\s+$/, "")
  if (!code.trim()) return original
  code = matchIndentation(code, original)
  const trailing = original.match(/(\r?\n)+$/)?.[0] ?? ""
  return code + trailing
}

export const clampContext = (text: string, fromEnd: boolean): string => {
  if (text.length <= EDIT_CONTEXT_CHARS) return text
  return fromEnd
    ? text.slice(text.length - EDIT_CONTEXT_CHARS)
    : text.slice(0, EDIT_CONTEXT_CHARS)
}
