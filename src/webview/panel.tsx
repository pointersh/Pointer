import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { EVENT_NAME, USER } from "../common/constants"
import { ChatCompletionMessage, MentionType, ToolStepView } from "../common/types"

import { useFilePaths } from "./hooks/useFilePaths"
import { useSelection } from "./hooks/useSelection"
import { useWorkspaceContext } from "./hooks/useWorkspaceContext"
import { cn } from "./ui/cn"
import { CodeBlock } from "./ui/codeBlock"
import { ConfirmCard } from "./ui/confirmCard"
import { LoadingState } from "./ui/loadingState"
import { PointingAt } from "./ui/pointingAt"
import { PromptBar, PromptModel, PromptOption } from "./ui/promptBar"
import { ThinkingState } from "./ui/thinkingState"
import { ToolChips } from "./ui/toolChips"
import { bridge, emit, useServerEvent } from "./messaging"
import { changeSummary, diffsOf, pointedChunks, runningLabel, toRow } from "./turn"
import { getThinkingMessage } from "./utils"

const MODEL_NAMES: Record<string, Omit<PromptModel, "id">> = {
  "pointer/primary": { name: "GLM-5.3 Flash", tag: "Flagship" },
  "pointer-backup/primary": { name: "DeepSeek V4.1 Flash", tag: "Backup" }
}
const FLAGSHIP = "pointer/primary"

const COMMANDS: PromptOption[] = [
  { key: "explain", name: "/explain", desc: "Explain how something works", insert: "Explain how " },
  { key: "fix", name: "/fix", desc: "Find and fix a bug", insert: "Find and fix the bug where " },
  { key: "test", name: "/test", desc: "Write tests for code", insert: "Write tests for " },
  { key: "refactor", name: "/refactor", desc: "Restructure without changing behaviour", insert: "Refactor " },
  { key: "review", name: "/review", desc: "Review recent changes", insert: "Review my uncommitted changes for bugs" }
]

const SUGGESTIONS = [
  { icon: "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z", text: "Explain how this repository is structured" },
  { icon: "M4 17l6-5-6-5M12 19h8", text: "Find where errors are handled and add a test for the edge cases" },
  { icon: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z", text: "Add a new command, with a test and docs" }
]

const FILE_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)

const openFile = (path: string, start?: number, end?: number) =>
  emit(EVENT_NAME.pointerOpenFile, { path, ...(start !== undefined ? { startLine: start - 1, endLine: (end ?? start) - 1 } : {}) })

const mentionsIn = (text: string): MentionType[] =>
  [...new Set([...text.matchAll(/(?:^|\s)@([\w./-]+)/g)].map((m) => m[1]))].map((path) => ({ name: path.split("/").pop() ?? path, path }))

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)

export function Panel() {
  const [messages, setMessages] = React.useState<ChatCompletionMessage[]>([])
  const [streaming, setStreaming] = React.useState<string | null>(null)
  const [steps, setSteps] = React.useState<ToolStepView[]>([])
  const [busy, setBusy] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [models, setModels] = React.useState<PromptModel[]>([])
  const conversation = React.useRef<string>(crypto.randomUUID())
  const thoughtAt = React.useRef<{ start?: number; end?: number }>({})
  const scroller = React.useRef<HTMLDivElement>(null)
  const pinned = React.useRef(true)
  const selection = useSelection()
  const { filePaths } = useFilePaths()
  const { contextItems, removeContextItem } = useWorkspaceContext()

  const applyModels = (chain: string[] | undefined) =>
    setModels((chain ?? []).map((id) => ({ id, ...(MODEL_NAMES[id] ?? { name: id }) })))

  React.useEffect(() => {
    void bridge.request(EVENT_NAME.pointerModels, {}).then(applyModels, () => undefined)
    emit(EVENT_NAME.pointerSidebarReady)
  }, [])

  React.useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, streaming, steps])

  useServerEvent(EVENT_NAME.pointerOnCompletion, (incoming) => {
    const content = String(incoming?.content ?? "")
    const { thinking, message } = getThinkingMessage(content)
    if (thinking && !thoughtAt.current.start) thoughtAt.current.start = Date.now()
    if (message.trim() && thoughtAt.current.start && !thoughtAt.current.end) thoughtAt.current.end = Date.now()
    setStreaming(content)
  })

  useServerEvent(EVENT_NAME.pointerToolSteps, (incoming) => setSteps(incoming ?? []))

  useServerEvent(EVENT_NAME.pointerAddMessage, (incoming) => {
    if (!incoming) return
    const { start, end } = thoughtAt.current
    const thought = start ? Math.max(1, Math.round(((end ?? Date.now()) - start) / 1000)) : undefined
    setMessages((current) => [...current, { ...incoming, meta: { ...incoming.meta, ...(thought ? { thoughtSeconds: thought } : {}) } }])
    setStreaming(null)
    setSteps([])
  })

  useServerEvent(EVENT_NAME.pointerStopGeneration, () => {
    setBusy(false)
    setStreaming(null)
  })

  useServerEvent(EVENT_NAME.pointerNewConversation, () => {
    conversation.current = crypto.randomUUID()
    setMessages([])
    setStreaming(null)
    setSteps([])
    setBusy(false)
  })

  const send = (text: string) => {
    const user: ChatCompletionMessage = { role: USER, content: text }
    const history = [...messages, user]
    setMessages(history)
    setBusy(true)
    setSteps([])
    setStreaming("")
    thoughtAt.current = {}
    pinned.current = true
    emit(EVENT_NAME.pointerChatMessage, {
      messages: history.map(({ role, content }) => ({ role, content })),
      mentions: mentionsIn(text),
      conversationId: conversation.current
    })
  }

  const stop = () => emit(EVENT_NAME.pointerStopGeneration)

  const waiting = steps.find((s) => s.status === "waiting")
  const answer = (run: boolean, always?: boolean) => {
    if (!waiting) return
    emit(EVENT_NAME.pointerToolApproval, { id: waiting.id, run, ...(always ? { always: true } : {}) })
  }

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (waiting) {
        event.preventDefault()
        answer(false)
      } else if (busy) {
        event.preventDefault()
        stop()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const mentions = React.useCallback(
    (query: string): PromptOption[] => {
      const q = query.toLowerCase()
      return filePaths
        .map((path) => ({ path, name: path.split("/").pop() ?? path }))
        .filter(({ path }) => !q || path.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.path.length - b.path.length)
        .slice(0, 8)
        .map(({ path, name }) => ({ key: path, name, desc: path, icon: FILE_ICON, insert: `@${path} ` }))
    },
    [filePaths]
  )

  const lastPrompt = () => [...messages].reverse().find((m) => m.role === USER)?.content as string | undefined

  const pickModel = (id: string) => void bridge.request(EVENT_NAME.pointerModels, { pick: id }).then(applyModels, () => undefined)

  const empty = messages.length === 0 && streaming === null

  return (
    <div className="flex h-full flex-col bg-page text-ink">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-4"
      >
        {empty ? (
          <EmptyState onPick={(text) => setDraft(text)} />
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((message, i) =>
              message.role === USER ? (
                <UserMessage key={i} text={String(message.content)} />
              ) : (
                <AssistantTurn
                  key={i}
                  content={String(message.content)}
                  steps={message.toolSteps ?? []}
                  thoughtSeconds={message.meta?.thoughtSeconds}
                  footer={message.meta}
                  onFollowUp={setDraft}
                />
              )
            )}
            {streaming !== null && (
              <AssistantTurn live content={streaming} steps={steps} onAnswer={answer} thinkingSince={thoughtAt.current.start} />
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-3">
        {selection && !busy && (
          <SelectionBar chars={selection.length} onPick={(text) => setDraft(text)} />
        )}
        {contextItems.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {contextItems.map((item) => (
              <span key={item.id} className="inline-flex h-6 max-w-full items-center gap-1 rounded-chip bg-surface pr-1 pl-2 font-mono text-[11px] text-ink-2 shadow-btn">
                <span className="truncate">{item.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => removeContextItem(item.id)}
                  className="flex size-4 items-center justify-center rounded-[4px] text-ink-3 hover:bg-hover hover:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <PromptBar
          value={draft}
          onValueChange={setDraft}
          busy={busy}
          models={models}
          model={models[0]?.id}
          flagship={FLAGSHIP}
          commands={COMMANDS}
          mentions={mentions}
          onSubmit={send}
          onStop={stop}
          onModelChange={pickModel}
          onRecall={lastPrompt}
        />
      </div>
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col justify-end gap-5 px-1 pb-4" style={{ animation: "fade-up 400ms var(--ease-out-strong) both" }}>
      <div>
        <p className="text-[18px] font-medium text-ink-3">Pointer</p>
        <p className="mt-0.5 text-[18px] leading-snug font-medium text-ink">What should we build?</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
          Pointer finds the right code first, then proposes changes you review hunk by hunk. Type <span className="font-mono text-ink">@</span> to add a file, <span className="font-mono text-ink">/</span> for commands.
        </p>
      </div>
      <div className="flex flex-col gap-0.5">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={s.text}
            type="button"
            onClick={() => onPick(s.text)}
            className="-mx-1.5 flex items-center gap-2.5 rounded-control px-1.5 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-100 hover:bg-hover"
            style={{ animation: `fade-up 400ms var(--ease-out-strong) ${120 + i * 60}ms both` }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-3" aria-hidden="true">
              <path d={s.icon} />
            </svg>
            {s.text}
          </button>
        ))}
      </div>
    </div>
  )
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end" style={{ animation: "fade-up 250ms var(--ease-out-strong) both" }}>
      <div className="max-w-[88%] rounded-[12px] rounded-br-[4px] bg-hover px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  )
}

interface TurnProps {
  content: string
  steps: ToolStepView[]
  live?: boolean
  thinkingSince?: number
  thoughtSeconds?: number
  footer?: ChatCompletionMessage["meta"]
  onAnswer?: (run: boolean, always?: boolean) => void
  onFollowUp?: (text: string) => void
}

function AssistantTurn({ content, steps, live, thinkingSince, thoughtSeconds, footer, onAnswer, onFollowUp }: TurnProps) {
  const { thinking, message } = getThinkingMessage(content)
  const visible = steps.filter((s) => !s.said)
  const pointed = visible.map(pointedChunks).find(Boolean)
  const rows = visible.map(toRow)
  const diffs = diffsOf(visible, (path) => openFile(path))
  const waiting = visible.find((s) => s.status === "waiting")
  const thinkingNow = live && !!thinking && !message.trim()
  const working = live && !thinkingNow && !message.trim() && !waiting
  const [elapsed, setElapsed] = React.useState(0)

  React.useEffect(() => {
    if (!thinkingNow || !thinkingSince) return
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - thinkingSince) / 1000)), 500)
    return () => clearInterval(timer)
  }, [thinkingNow, thinkingSince])

  return (
    <div className="flex flex-col gap-2.5" style={{ animation: "fade-in 250ms ease-out both" }}>
      {thinking && (
        <ThinkingState
          active={thinkingNow}
          label={thinkingNow ? `Thinking${elapsed ? ` · ${elapsed}s` : ""}` : `Thought for ${thoughtSeconds ?? Math.max(1, elapsed)}s`}
          steps={[{ kind: "reasoning", label: "Reasoning", detail: thinking }]}
        />
      )}
      {pointed && <PointingAt chunks={pointed.chunks} dropped={pointed.dropped} onOpen={(c) => openFile(c.path, c.start, c.end)} />}
      {rows.length > 0 && (
        <ToolChips
          rows={rows}
          diffs={diffs}
          header={`${rows.length} step${rows.length === 1 ? "" : "s"}${diffs.length ? ` · ${diffs.length} file${diffs.length === 1 ? "" : "s"} changed` : ""}`}
        />
      )}
      {waiting && onAnswer && (
        <ConfirmCard
          key={waiting.id}
          question={waiting.approval === "change" ? `Apply this change to ${(waiting.args?.path ?? "the file").split("/").pop()}?` : "Run this command?"}
          target={waiting.approval === "change" ? changeSummary(waiting) : (waiting.command ?? waiting.args?.command ?? waiting.name)}
          confirmLabel={waiting.approval === "change" ? "Apply" : "Run"}
          onConfirm={() => onAnswer(true)}
          onSkip={() => onAnswer(false)}
          onAlways={waiting.approval !== "change" && !waiting.noAlways ? () => onAnswer(true, true) : undefined}
        />
      )}
      {working && <LoadingState label={runningLabel(visible) ?? (rows.length ? "Working" : "Pointing")} />}
      {message.trim() && <Reply text={message} live={live} />}
      {!live && footer && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
          {footer.model && <span>{MODEL_NAMES[footer.model]?.name ?? footer.model}</span>}
          {footer.durationMs !== undefined && <span className="tabular-nums">· {seconds(footer.durationMs)}</span>}
          {footer.stopped && <span>· stopped</span>}
          <CopyButton text={message} />
        </div>
      )}
      {!live && onFollowUp && diffs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {["Run the tests", "Explain the changes", "Review for edge cases"].map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onFollowUp(text)}
              className="h-7 rounded-full px-3 text-[12px] text-ink-2 shadow-btn transition-colors duration-100 hover:bg-hover hover:text-ink"
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Reply({ text, live }: { text: string; live?: boolean }) {
  return (
    <div className={cn("reply text-[13px] leading-relaxed text-ink", live && "after:ml-0.5 after:inline-block after:h-3.5 after:w-0.5 after:translate-y-0.5 after:animate-pulse after:rounded-full after:bg-ink after:content-['']")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          a: ({ href, children }) => (
            <a href={href} className="text-accent-ink underline decoration-transparent underline-offset-2 hover:decoration-current">
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          h1: ({ children }) => <h3 className="mt-3 mb-1.5 text-[14px] font-semibold">{children}</h3>,
          h2: ({ children }) => <h3 className="mt-3 mb-1.5 text-[13.5px] font-semibold">{children}</h3>,
          h3: ({ children }) => <h4 className="mt-3 mb-1 text-[13px] font-semibold">{children}</h4>,
          code: ({ className, children }) => {
            const language = /language-(\w+)/.exec(className ?? "")?.[1]
            const code = String(children)
            if (!language && !code.includes("\n")) {
              return <code className="rounded-[4px] bg-inset px-1 py-px font-mono text-[12px] text-ink shadow-hairline">{code}</code>
            }
            return <CodeBlock className="my-2" code={code} language={language} />
          },
          pre: ({ children }) => <>{children}</>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }
      className="ml-auto rounded-[6px] px-1.5 py-0.5 text-[11px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

function SelectionBar({ chars, onPick }: { chars: number; onPick: (text: string) => void }) {
  const actions = [
    { label: "Explain", text: "Explain the selected code" },
    { label: "Improve", text: "Improve the selected code" },
    { label: "Test", text: "Write tests for the selected code" }
  ]
  return (
    <div className="flex items-center gap-1 rounded-full bg-surface p-1 pl-3 shadow-raised" style={{ animation: "pop-in 180ms var(--ease-out-strong) both" }}>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3 tabular-nums">{chars} characters selected</span>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={() => onPick(a.text)}
          className="h-6 rounded-full px-2.5 text-[12px] font-medium text-ink transition-colors duration-100 hover:bg-hover"
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}
