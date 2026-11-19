import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { logger } from "../../common/logger"

import { retrievalEndpoint } from "./client"

const PREFETCH_BUDGET_TOKENS = 3000
const PREFETCH_TIMEOUT_MS = 5000

// The fused score passes ~0.048 only when two ranking signals agree on a chunk (BM25 and a name, a file name
// or the reference graph). Measured on Flask: chit-chat ("say hi", "thanks", "hello") tops out at 0.044, real
// questions start at 0.052. Below it the search is noise, so nothing is shown or sent.
const RELEVANT_SCORE = 0.048
const relevant = (text: string) => {
  const top = /^.+?:\d+-\d+ · ([\d.]+) · /m.exec(text)
  return !!top && Number(top[1]) >= RELEVANT_SCORE
}

// One call to a pointer-retrieval tool with a deadline; undefined when retrieval is off, slow or failing.
const callRetrieval = async (name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string | undefined> => {
  const endpoint = retrievalEndpoint()
  if (!endpoint) return undefined
  const client = new Client({ name: "pointer", version: "0.1.0" })
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(PREFETCH_TIMEOUT_MS)])
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } }
      }),
      { signal: timeout, timeout: PREFETCH_TIMEOUT_MS }
    )
    const result = await client.callTool({ name, arguments: args }, undefined, { signal: timeout, timeout: PREFETCH_TIMEOUT_MS })
    const content = result.content as { type: string; text?: string }[]
    return content.find((part) => part.type === "text")?.text
  } catch (error) {
    logger.warn(`Retrieval ${name} skipped: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    void client.close().catch(() => undefined)
  }
}

// Automatic context: search_codebase for the request, before the model sees it. Undefined when retrieval is
// off or slow; the agent then searches on its own, as before.
export const prefetchContext = async (query: string, signal: AbortSignal): Promise<string | undefined> => {
  if (!query.trim()) return undefined
  const text = await callRetrieval("search_codebase", { query, budget_tokens: PREFETCH_BUDGET_TOKENS }, signal)
  return text && relevant(text) ? text : undefined
}

// The inline-edit syntax gate: the line where an edit breaks a file that parsed before it, or undefined
// (it still parses, it already did not, the language has no parser, or retrieval is unavailable).
export const syntaxBreak = async (path: string, before: string, after: string, signal: AbortSignal): Promise<number | undefined> => {
  const line = /^error at line (\d+)/.exec((await callRetrieval("check_syntax", { path, text: after }, signal)) ?? "")?.[1]
  if (!line || (await callRetrieval("check_syntax", { path, text: before }, signal)) !== "ok") return undefined
  return Number(line)
}
