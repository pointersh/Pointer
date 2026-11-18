import * as React from "react"

import { cn } from "./cn"

export interface PointedChunk {
  path: string
  start: number
  end: number
  score: number
  reason: string
  more: number
}

interface PointingAtProps extends React.HTMLAttributes<HTMLDivElement> {
  chunks: PointedChunk[]
  dropped?: string
  live?: boolean
  onOpen?: (chunk: PointedChunk) => void
}

// The search itself takes milliseconds; a short "searching" beat lets the eye register that it happened
// before the result settles into a collapsed summary. Past replies skip it.
const SEARCH_BEAT_MS = 650

export function PointingAt({ chunks, dropped, live, onOpen, className, ...props }: PointingAtProps) {
  const [searching, setSearching] = React.useState(!!live)
  const [open, setOpen] = React.useState(false)
  const [all, setAll] = React.useState(false)

  React.useEffect(() => {
    if (!searching) return
    const timer = setTimeout(() => setSearching(false), SEARCH_BEAT_MS)
    return () => clearTimeout(timer)
  }, [searching])

  const top = Math.max(...chunks.map((c) => c.score), 0.0001)
  const shown = all ? chunks : chunks.slice(0, 5)
  const names = [...new Set(chunks.map((c) => c.path.split("/").pop() ?? c.path))]
  const summary = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "")

  if (searching) {
    return (
      <div className={cn("flex items-center gap-2 px-0.5 py-1", className)} {...props}>
        <Pointer />
        <span
          className="text-[12.5px] font-medium"
          style={{
            backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
            backgroundSize: "200% 100%",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            animation: "bui-shimmer-text 1.4s linear infinite"
          }}
        >
          Pointing… searching the codebase
        </span>
      </div>
    )
  }

  return (
    <div className={cn("w-full", className)} {...props}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1.5 flex w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-control px-1.5 py-1 text-left text-[12.5px] transition-colors duration-100 hover:bg-hover-2"
        style={{ animation: "fade-in 220ms ease-out both" }}
      >
        <Pointer />
        <span className="shrink-0 font-medium text-ink">
          Pointed at {names.length} file{names.length === 1 ? "" : "s"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3">{summary}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-ink-3 transition-transform duration-200"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: "var(--ease-out-strong)" }}
      >
        <div className="min-h-0 overflow-hidden">
          {open && (
            <div className="mt-1.5 overflow-hidden rounded-card bg-surface shadow-card">
              {shown.map((chunk, i) => {
                const name = chunk.path.split("/").pop() ?? chunk.path
                const dir = chunk.path.slice(0, chunk.path.length - name.length)
                return (
                  <button
                    key={`${chunk.path}:${chunk.start}`}
                    type="button"
                    onClick={() => onOpen?.(chunk)}
                    className="group flex w-full flex-col gap-1 border-b border-line px-2.5 py-2 text-left transition-colors duration-100 last:border-b-0 hover:bg-hover"
                    style={{ animation: `fade-up 260ms var(--ease-out-strong) ${i * 40}ms both` }}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                        <span className="text-ink-3">{dir}</span>
                        <span className="font-medium text-ink">{name}</span>
                        <span className="text-ink-3">
                          :{chunk.start}
                          {chunk.end > chunk.start ? `–${chunk.end}` : ""}
                        </span>
                      </span>
                      {chunk.more > 0 && <span className="shrink-0 text-[11px] text-ink-3">+{chunk.more}</span>}
                      <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-line">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(8, (chunk.score / top) * 100)}%` }} />
                      </span>
                    </span>
                    <span title={chunk.reason} className="line-clamp-1 text-[11.5px] leading-[1.45] text-ink-2">{chunk.reason}</span>
                  </button>
                )
              })}
              {chunks.length > shown.length && (
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className="w-full px-2.5 py-1.5 text-left text-[11.5px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2"
                >
                  Show {chunks.length - shown.length} more
                </button>
              )}
              {dropped && <div className="border-t border-line px-2.5 py-1.5 text-[11px] text-ink-3">{dropped}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Pointer() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
      <path d="M4 3l7 17 2.5-7.5L21 10z" />
    </svg>
  )
}
