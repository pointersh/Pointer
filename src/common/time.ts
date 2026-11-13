
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const formatRelativeTime = (timestamp: number, now = Date.now()) => {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} d ago`
  return new Date(timestamp).toLocaleDateString()
}

export type DateBucket = "today" | "yesterday" | "this-week" | "older"

const startOfDay = (time: number) => {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export const getDateBucket = (
  timestamp: number | undefined,
  now = Date.now()
): DateBucket => {
  if (!timestamp) return "older"
  const today = startOfDay(now)
  if (timestamp >= today) return "today"
  if (timestamp >= today - DAY) return "yesterday"
  if (timestamp >= today - 6 * DAY) return "this-week"
  return "older"
}

export const DATE_BUCKETS: DateBucket[] = ["today", "yesterday", "this-week", "older"]

export const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}
