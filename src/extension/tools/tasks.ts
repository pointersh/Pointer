import { parseLenientJson } from "./protocol"

export interface Task {
  text: string
  done: boolean
}

const MAX_TASKS = 20
const MAX_TASK_CHARS = 200

export const TASKS_TOOL_NAME = "update_tasks"

const DONE_WORDS = /^(done|completed?|finished|x|true|yes)$/i

const fromJson = (value: unknown): Task[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const tasks: Task[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      const [task] = fromLines(entry)
      if (task) tasks.push(task)
    } else if (entry && typeof entry === "object") {
      const { text, task, content, title, step, done, completed, status } = entry as Record<string, unknown>
      const said = [text, task, content, title, step].find((v) => typeof v === "string" && v.trim()) as string | undefined
      if (!said) continue
      tasks.push({
        text: said.trim(),
        done: done === true || completed === true || DONE_WORDS.test(String(status ?? done ?? completed ?? ""))
      })
    }
  }
  return tasks
}

const fromLines = (text: string): Task[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const body = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "")
      const box = body.match(/^\[([^\]]?)\]\s*(.*)$/)
      if (box) return { text: box[2].trim(), done: /^[xX✓✔]$/.test(box[1]) }
      const ticked = body.match(/^[✓✔☑]\s*(.*)$/)
      if (ticked) return { text: ticked[1].trim(), done: true }
      return { text: body.replace(/^[☐□]\s*/, "").trim(), done: false }
    })
    .filter((task) => task.text)

export const parseTasks = (raw: string | undefined): Task[] | undefined => {
  const text = raw?.trim()
  if (!text) return undefined
  const parsed = text.startsWith("[{") || text.startsWith("[\"") ? parseLenientJson(text) : undefined
  const tasks = (parsed && "value" in parsed ? fromJson(parsed.value) : undefined) ?? fromLines(text)
  const kept = tasks
    .slice(0, MAX_TASKS)
    .map((task) => ({ text: task.text.length > MAX_TASK_CHARS ? `${task.text.slice(0, MAX_TASK_CHARS)}…` : task.text, done: task.done }))
  return kept.length ? kept : undefined
}

export const tasksProgress = (tasks: Task[]) => `${tasks.filter((task) => task.done).length} of ${tasks.length} done`
