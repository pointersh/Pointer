import { InferenceError } from "./errors"
import { ChatChunk, FimChunk } from "./types"

const cancelled = (reason: unknown) =>
  new InferenceError("cancelled", "The request was cancelled.", {
    cause: reason
  })

export async function* abortable<T>(
  source: AsyncIterable<T>,
  signal?: AbortSignal
): AsyncGenerator<T, void, undefined> {
  if (!signal) {
    yield* source
    return
  }
  const iterator = source[Symbol.asyncIterator]()
  let onAbort = () => undefined as void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelled(signal.reason))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  aborted.catch(() => undefined)

  try {
    for (;;) {
      const result = await Promise.race([iterator.next(), aborted])
      if (result.done) return
      yield result.value
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    void iterator.return?.().catch(() => undefined)
  }
}

export const readText = async (
  stream: AsyncIterable<FimChunk | ChatChunk>
): Promise<string> => {
  let text = ""
  for await (const chunk of stream) {
    text += "text" in chunk ? chunk.text : chunk.content
  }
  return text
}
