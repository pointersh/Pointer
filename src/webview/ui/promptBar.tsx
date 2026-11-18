import * as React from "react"

import { cn } from "./cn"

export interface PromptModel {
  id: string
  name: string
  group?: string
}

export interface PromptOption {
  key: string
  name: string
  desc?: string
  icon?: React.ReactNode
  insert: string
}

interface PromptBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSubmit"> {
  placeholder?: string
  value?: string
  onValueChange?: (value: string) => void
  models?: PromptModel[]
  model?: string
  busy?: boolean
  maxRows?: number
  commands?: PromptOption[]
  mentions?: (query: string) => PromptOption[]
  onSubmit?: (value: string) => void
  onStop?: () => void
  onModelChange?: (id: string) => void
  onRecall?: () => string | undefined
}

type Token = { kind: "at" | "slash"; query: string; start: number }

const tokenAt = (text: string, caret: number): Token | null => {
  const before = text.slice(0, caret)
  const match = /(^|\s)([@/])([^\s@/]*)$/.exec(before)
  if (!match) return null
  if (match[2] === "/" && before.trim() !== `/${match[3]}`) return null
  return { kind: match[2] === "@" ? "at" : "slash", query: match[3].toLowerCase(), start: caret - match[3].length - 1 }
}

export function PromptBar({
  placeholder = "Ask Pointer to change, find or explain code",
  value: controlled,
  onValueChange,
  models = [],
  model,
  busy = false,
  maxRows = 10,
  commands = [],
  mentions,
  onSubmit,
  onStop,
  onModelChange,
  onRecall,
  className,
  ...props
}: PromptBarProps) {
  const [own, setOwn] = React.useState("")
  const value = controlled ?? own
  const setValue = (next: string) => (onValueChange ? onValueChange(next) : setOwn(next))
  const [caret, setCaret] = React.useState(0)
  const [active, setActive] = React.useState(0)
  const [dismissed, setDismissed] = React.useState(false)
  const [modelOpen, setModelOpen] = React.useState(false)
  const modelMenu = React.useRef<HTMLDivElement>(null)
  // The menu sits over the prompt: Escape or a click anywhere else closes it without picking.
  React.useEffect(() => {
    if (!modelOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return
        e.stopPropagation() // Escape closes the menu only; it must not also stop a running request
        setModelOpen(false)
      } else if (!modelMenu.current?.contains(e.target as Node)) setModelOpen(false)
    }
    document.addEventListener("keydown", close, true)
    document.addEventListener("mousedown", close, true)
    return () => {
      document.removeEventListener("keydown", close, true)
      document.removeEventListener("mousedown", close, true)
    }
  }, [modelOpen])
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  useAutoGrow(textareaRef, value, maxRows)

  const token = dismissed ? null : tokenAt(value, caret)
  const rows: PromptOption[] =
    token?.kind === "slash"
      ? commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(token.query))
      : token?.kind === "at" && mentions
        ? mentions(token.query).slice(0, 8)
        : []
  const menuOpen = !!token && (token.kind === "slash" ? commands.length > 0 : !!mentions)

  React.useEffect(() => setActive(0), [token?.kind, token?.query])

  const pickModel = (id: string) => {
    setModelOpen(false)
    if (id === model) return
    onModelChange?.(id)
    textareaRef.current?.focus()
  }

  const pick = (row: PromptOption) => {
    if (!token) return
    const next = `${value.slice(0, token.start)}${row.insert}${value.slice(caret)}`
    const at = token.start + row.insert.length
    setValue(next)
    setDismissed(false)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(at, at)
      setCaret(at)
    })
  }

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed || busy) return
    onSubmit?.(trimmed)
    setValue("")
  }

  const current = models.find((m) => m.id === model) ?? models[0]

  return (
    <div className={cn("relative w-full", className)} {...props}>
      {menuOpen && (
        <div
          role="listbox"
          className="absolute inset-x-0 bottom-full z-30 mb-1.5 rounded-[12px] bg-surface p-1 shadow-overlay"
          style={{ animation: "bui-pop-in 160ms var(--ease-out-strong) both", transformOrigin: "bottom center" }}
        >
          {rows.map((row, i) => (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(row)}
              className={cn(
                "flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2 text-left transition-colors duration-100",
                i === active && "bg-hover"
              )}
            >
              {row.icon && <span className="flex size-4 shrink-0 items-center justify-center text-ink-2">{row.icon}</span>}
              <span className="shrink-0 font-mono text-[12px] font-medium text-ink">{row.name}</span>
              {row.desc && <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3">{row.desc}</span>}
            </button>
          ))}
          {rows.length === 0 && (
            <div className="flex h-8 items-center px-2 text-[12px] text-ink-3">
              {token?.query ? `No matches for “${token.query}”` : "Type to search"}
            </div>
          )}
          <div className="mt-1 border-t border-line px-2 pt-1.5 pb-0.5 text-[11px] text-ink-3">
            {token?.kind === "at" ? "Files and symbols · ↑↓ to move, Enter to add" : "Commands · ↑↓ to move, Enter to run"}
          </div>
        </div>
      )}

      <div className="relative isolate flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-card transition-[border-color] duration-150 focus-within:border-line-strong">
        <textarea
          ref={textareaRef}
          rows={2}
          value={value}
          placeholder={placeholder}
          aria-label="Prompt"
          onChange={(e) => {
            setValue(e.target.value)
            setCaret(e.target.selectionStart)
            setDismissed(false)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (menuOpen && rows.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length)
                return
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault()
                pick(rows[active])
                return
              }
            }
            if (menuOpen && e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              setDismissed(true)
              return
            }
            if (e.key === "ArrowUp" && !value && onRecall) {
              const last = onRecall()
              if (last) {
                e.preventDefault()
                setValue(last)
              }
              return
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          className="min-h-9 w-full min-w-0 resize-none bg-transparent px-1.5 py-1 text-[13px] leading-[18px] text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3"
        />

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Mention a file or symbol"
            onClick={() => {
              const el = textareaRef.current
              const at = el?.selectionStart ?? value.length
              const spaced = at > 0 && !/\s/.test(value[at - 1] ?? "") ? " @" : "@"
              setValue(`${value.slice(0, at)}${spaced}${value.slice(at)}`)
              requestAnimationFrame(() => {
                el?.focus()
                el?.setSelectionRange(at + spaced.length, at + spaced.length)
                setCaret(at + spaced.length)
              })
            }}
            className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.94]"
          >
            <Icon path="M12 5v14M5 12h14" />
          </button>

          <div ref={modelMenu} className="relative ml-auto">
            {current && (
              <button
                type="button"
                aria-expanded={modelOpen}
                aria-label="Choose model"
                onClick={() => setModelOpen((o) => !o)}
                className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
              >
                {current.name}
                <span className="text-ink-3">
                  <Icon path="M6 9l6 6 6-6" size={11} width={2.4} />
                </span>
              </button>
            )}
            {modelOpen && models.length > 0 && (
              <ModelMenu models={models} current={current?.id} onPick={pickModel} />
            )}
          </div>

          <button
            type="button"
            aria-label={busy ? "Stop" : "Send"}
            title={busy ? "Stop (Esc)" : "Send (Enter)"}
            onClick={busy ? onStop : submit}
            disabled={!busy && !value.trim()}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-page transition-[opacity,transform] duration-200 active:scale-[0.94] disabled:opacity-30"
          >
            {busy ? <span className="size-2.5 rounded-[2px] bg-page" /> : <Icon path="M12 19V5M5 12l7-7 7 7" />}
          </button>
        </div>
      </div>
    </div>
  )
}

function Icon({ path, size = 15, width = 1.8 }: { path: string; size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, maxRows: number) {
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    const max = 18 * maxRows
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden"
  }, [ref, value, maxRows])
}

// Every model TrueForge offers: provider tabs, a search box, and the list. Arrow keys move, Enter picks.
function ModelMenu({ models, current, onPick }: { models: PromptModel[]; current?: string; onPick: (id: string) => void }) {
  const groups = [...new Set(models.map((m) => m.group ?? "Other"))]
  const [tab, setTab] = React.useState(() => models.find((m) => m.id === current)?.group ?? "All")
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const search = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => search.current?.focus(), [])

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = models.filter(
    (m) =>
      (query || tab === "All" || (m.group ?? "Other") === tab) &&
      words.every((w) => `${m.name} ${m.group ?? ""}`.toLowerCase().includes(w))
  )
  React.useEffect(() => setActive(0), [query, tab])

  return (
    <div
      role="menu"
      className="absolute right-0 bottom-full z-30 mb-1.5 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col rounded-[10px] bg-surface p-1 shadow-raised"
      style={{ animation: "bui-pop-in 180ms var(--ease-out-strong) both", transformOrigin: "bottom right" }}
    >
      <input
        ref={search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setActive((i) => Math.min(i + 1, shown.length - 1))
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === "Enter" && shown[active]) {
            e.preventDefault()
            onPick(shown[active].id)
          }
        }}
        placeholder="Search models"
        aria-label="Search models"
        className="mb-1 h-7 w-full rounded-[6px] bg-inset px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-3"
      />
      {!query && groups.length > 1 && (
        <div className="mb-1 flex gap-0.5 overflow-x-auto pb-0.5">
          {["All", ...groups].map((g) => (
            <button
              key={g}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(g)}
              className={cn(
                "h-6 shrink-0 rounded-[6px] px-2 text-[11.5px] transition-colors duration-100",
                tab === g ? "bg-hover-2 font-medium text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2"
              )}
            >
              {g}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-64 overflow-y-auto">
        {shown.map((m, i) => (
          <button
            key={m.id}
            type="button"
            role="menuitemradio"
            aria-checked={m.id === current}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(m.id)}
            className={cn("flex h-7.5 w-full items-center gap-2 rounded-[6px] px-2 text-left transition-colors duration-100", i === active && "bg-hover")}
          >
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{m.name}</span>
            {(query || tab === "All") && <span className="shrink-0 text-[11px] text-ink-3">{m.group}</span>}
            <span className={cn("shrink-0 text-ink", m.id !== current && "invisible")}>
              <Icon path="M20 6L9 17l-5-5" size={13} width={2.5} />
            </span>
          </button>
        ))}
        {shown.length === 0 && <div className="flex h-8 items-center px-2 text-[12px] text-ink-3">No models match “{query}”</div>}
      </div>
    </div>
  )
}
