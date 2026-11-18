import * as vscode from "vscode"

import { logger } from "../../common/logger"
import { ChatCompletionMessage } from "../../common/types"
import { TextModel } from "../model"

import { describeError, inlineModelChain, modelSpec } from "./client"
import { cancelSession, createSession, pause, RATE_LIMIT_RETRIES, RATE_LIMITED, retryDelay, runTurn } from "./session"

const NO_TOOLS = { dynamic_sub_agents: { enabled: false }, ask_user_questions: { enabled: false }, generative_ui: { enabled: false } }

const streamOn = async function* (model: string, messages: ChatCompletionMessage[], signal: AbortSignal) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n")
  const input = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n")
  const sessionId = await createSession({ spec: { model: modelSpec(model), instructions: system, mcp_servers: [], config: NO_TOOLS } })
  const onAbort = () => void cancelSession(sessionId)
  signal.addEventListener("abort", onAbort, { once: true })
  const chunks: string[] = []
  let wake: (() => void) | undefined
  let finished = false
  let sent = 0
  const done = runTurn(sessionId, input, {
    onText: (text) => {
      if (text.length <= sent) return
      chunks.push(text.slice(sent))
      sent = text.length
      wake?.()
    }
  }, signal).finally(() => {
    finished = true
    wake?.()
  })
  try {
    for (;;) {
      while (chunks.length) yield chunks.shift()!
      if (finished) break
      await new Promise<void>((resolve) => (wake = resolve))
    }
    const result = await done
    if (result.status === "error") throw new Error(result.error ?? "The model failed.")
  } finally {
    signal.removeEventListener("abort", onAbort)
    // The consumer stopped early (the file changed under the edit): stop the turn too.
    if (!finished) {
      void cancelSession(sessionId)
      done.catch(() => undefined)
    }
  }
}

export const trueforgeTextModel = (): TextModel => ({
  get name() {
    return inlineModelChain()[0]
  },
  async *stream(messages, signal) {
    const chain = inlineModelChain()
    let retries = 0
    for (let i = 0; i < chain.length; i++) {
      let produced = false
      try {
        for await (const chunk of streamOn(chain[i], messages, signal)) {
          produced = true
          yield chunk
        }
        return
      } catch (error) {
        const message = describeError(error)
        if (signal.aborted || produced) throw new Error(message)
        if (RATE_LIMITED.test(message) && retries < RATE_LIMIT_RETRIES) {
          const seconds = retryDelay(message, retries++)
          vscode.window.setStatusBarMessage(`Pointer: ${chain[i]} is rate-limited; retrying in ${seconds}s`, seconds * 1000)
          await pause(seconds * 1000, signal)
          if (signal.aborted) throw new Error(message)
          i--
          continue
        }
        retries = 0
        if (i === chain.length - 1) throw new Error(message)
        const notice = `Pointer: ${chain[i]} failed (${describeError(error)}); retrying on ${chain[i + 1]}`
        logger.warn(notice)
        vscode.window.setStatusBarMessage(notice, 8000)
      }
    }
  }
})
