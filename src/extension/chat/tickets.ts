// Carries a tool call's abort signal across executeCommand (which takes only plain arguments), so a queued
// edit can tell that TrueForge has cancelled the call that proposed it.
const signals = new Map<string, AbortSignal>()
let next = 0

export const ticketFor = (signal?: AbortSignal) => {
  if (!signal) return undefined
  const ticket = String(++next)
  signals.set(ticket, signal)
  return ticket
}

export const cancelled = (ticket?: string) => !!ticket && !!signals.get(ticket)?.aborted

export const release = (ticket?: string) => ticket && signals.delete(ticket)
