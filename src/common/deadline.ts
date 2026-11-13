
export interface Deadline {
  readonly signal: AbortSignal
  answered(): void
  done(): void
}

export interface DeadlineOptions {
  parent?: AbortSignal
  reason?: () => unknown
}

export const deadline = (ms: number, options: DeadlineOptions = {}): Deadline => {
  const { parent, reason } = options
  const controller = new AbortController()
  const forward = () => controller.abort(parent?.reason)
  if (parent?.aborted) forward()
  else parent?.addEventListener("abort", forward, { once: true })
  const timer = setTimeout(() => controller.abort(reason?.()), ms)
  ;(timer as { unref?: () => void }).unref?.()
  const answered = () => clearTimeout(timer)
  return {
    signal: controller.signal,
    answered,
    done: () => {
      answered()
      parent?.removeEventListener("abort", forward)
    }
  }
}
