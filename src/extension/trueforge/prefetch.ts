import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { logger } from "../../common/logger"

import { retrievalEndpoint } from "./client"

const PREFETCH_BUDGET_TOKENS = 3000
const PREFETCH_TIMEOUT_MS = 5000

// Automatic context: search_codebase for the request, before the model sees it. Undefined when retrieval is
// off or slow; the agent then searches on its own, as before.
export const prefetchContext = async (query: string, signal: AbortSignal): Promise<string | undefined> => {
  const endpoint = retrievalEndpoint()
  if (!endpoint || !query.trim()) return undefined
  const client = new Client({ name: "pointer", version: "0.1.0" })
  const timeout = AbortSignal.timeout(PREFETCH_TIMEOUT_MS)
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } }
      })
    )
    const result = await client.callTool(
      { name: "search_codebase", arguments: { query, budget_tokens: PREFETCH_BUDGET_TOKENS } },
      undefined,
      { signal: AbortSignal.any([signal, timeout]), timeout: PREFETCH_TIMEOUT_MS }
    )
    const content = result.content as { type: string; text?: string }[]
    return content.find((part) => part.type === "text")?.text
  } catch (error) {
    logger.warn(`Context prefetch skipped: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    void client.close().catch(() => undefined)
  }
}
