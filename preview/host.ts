import { ASSISTANT } from "../src/common/constants"
import { EVENT_NAME } from "../src/common/constants/events"
import { ToolSteps } from "../src/extension/chat/toolSteps"
import session from "./session.json"

interface Diff {
  file: string
  startLine: number
  original: string
  text: string
}

interface Step {
  kind: "think" | "tool" | "text"
  text?: string
  name?: string
  args?: Record<string, string>
  output?: string
  approval?: "change" | "command"
  diffs?: Diff[]
}

const steps = session.steps as Step[]

const FILES = [
  "src/flask/app.py",
  "src/flask/cli.py",
  "src/flask/config.py",
  "src/flask/helpers.py",
  "tests/test_cli.py",
  "tests/test_config.py",
  "docs/cli.rst",
  "docs/config.rst"
]

const send = (type: string, data?: unknown, id?: string) => window.postMessage({ type, data, id }, "*")
const toEditor = (message: unknown) => window.parent.postMessage(message, "*")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let run = 0
const tools = new ToolSteps((view) => send(EVENT_NAME.pointerToolSteps, view))

const stream = async (prefix: string, text: string, token: number) => {
  const words = text.split(/(\s+)/)
  let shown = ""
  for (const word of words) {
    if (token !== run) return false
    shown += word
    send(EVENT_NAME.pointerOnCompletion, { role: ASSISTANT, content: `${prefix}${shown}` })
    await pause(18)
  }
  return token === run
}

const play = async () => {
  const token = ++run
  const started = Date.now()
  tools.reset()
  let thinking = ""
  let answer = ""
  for (const [index, step] of steps.entries()) {
    if (token !== run) return
    if (step.kind === "think") {
      const before = thinking ? `${thinking}\n\n` : ""
      if (!(await stream(`<think>${before}`, step.text ?? "", token))) return
      thinking = `${before}${step.text}`
      send(EVENT_NAME.pointerOnCompletion, { role: ASSISTANT, content: `<think>${thinking}</think>` })
      continue
    }
    if (step.kind === "text") {
      if (!(await stream(`<think>${thinking}</think>\n\n`, step.text ?? "", token))) return
      answer = step.text ?? ""
      continue
    }
    const id = `call-${index}`
    tools.start({ id, name: step.name ?? "tool", args: step.args ?? {} })
    await pause(step.name === "search_codebase" ? 450 : 300)
    if (step.approval) {
      const detail = step.args?.command ?? step.args?.path ?? step.name ?? "this action"
      const allowed = await tools.approve(detail, step.approval, { always: false })
      if (token !== run) return
      if (!allowed) {
        tools.finish({ id, index: 0, summary: "declined", output: "The user declined this step." })
        continue
      }
      if (step.diffs) toEditor({ type: "preview-diffs", diffs: step.diffs })
      await pause(step.name === "run_command" ? 900 : 250)
    }
    const output = step.output ?? ""
    tools.finish({ id, index: 0, summary: output.split("\n")[0]?.slice(0, 120) ?? "", output })
    await pause(250)
  }
  if (token !== run) return
  tools.settle()
  send(EVENT_NAME.pointerAddMessage, {
    role: ASSISTANT,
    content: `<think>${thinking}</think>\n\n${answer}`,
    meta: { model: "pointer/primary", provider: "TrueForge", durationMs: Date.now() - started },
    toolSteps: tools.steps
  })
  send(EVENT_NAME.pointerStopGeneration)
}

const stop = () => {
  run++
  tools.settle()
  send(EVENT_NAME.pointerStopGeneration)
}

const reply = (type: string, id: string | undefined, data: unknown) => send(type, data, id)

const handle = ({ type, data, id }: { type: string; data?: unknown; id?: string }) => {
  switch (type) {
    case EVENT_NAME.pointerChatMessage:
      void play()
      return
    case EVENT_NAME.pointerStopGeneration:
      stop()
      return
    case EVENT_NAME.pointerToolApproval: {
      const { id: step, run: allowed } = data as { id: string; run: boolean }
      tools.answer(step, allowed)
      return
    }
    case EVENT_NAME.pointerNewConversation:
      stop()
      toEditor({ type: "preview-reset" })
      return
    case EVENT_NAME.pointerOpenFile:
      toEditor({ type: "preview-open", target: data })
      return
    case EVENT_NAME.pointerFileListRequest:
      reply(type, id, FILES)
      return
    case EVENT_NAME.pointerSymbolSearch:
      reply(type, id, [])
      return
    case EVENT_NAME.pointerTextSelection:
      reply(type, id, "")
      return
    case EVENT_NAME.pointerSendTheme:
      reply(type, id, document.documentElement.dataset.theme === "light" ? "Light" : "Dark")
      return
    case EVENT_NAME.pointerGlobalContext:
    case EVENT_NAME.pointerGetWorkspaceContext:
    case EVENT_NAME.pointerSessionContext:
      reply(type, id, { key: (data as { key: string }).key, value: undefined })
      return
    case EVENT_NAME.pointerGetContextItems:
      send(EVENT_NAME.pointerUpdateContextItems, [])
      return
    default:
      if (id) reply(type, id, undefined)
  }
}

let state: unknown
Object.assign(window, {
  acquireVsCodeApi: () => ({
    postMessage: (message: { type: string; data?: unknown; id?: string }) => setTimeout(() => handle(message)),
    getState: () => state,
    setState: (next: unknown) => (state = next)
  })
})
