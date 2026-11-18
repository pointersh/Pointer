import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "./cn"

const ICONS: Record<string, React.ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  write: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </g>
  ),
  run: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17l6-5-6-5M12 19h8" />
    </g>
  ),
  read: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </g>
  ),
  search: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </g>
  ),
  point: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
    </g>
  )
}

export type ToolIcon = keyof typeof ICONS
export type ToolRowStatus = "running" | "waiting" | "done" | "error"
export type ToolDetailLine = { text: string; tone?: "add" | "del" }

export interface ToolRow {
  id: string
  icon: ToolIcon
  label: string
  chip?: string
  mono?: boolean
  status: ToolRowStatus
  detail?: ToolDetailLine[]
  detailMono?: boolean
  body?: React.ReactNode
}

export interface ToolDiff {
  id: string
  file: string
  add: number
  del: number
  lines?: ToolDetailLine[]
  onOpen?: () => void
}

interface ToolChipsProps extends React.HTMLAttributes<HTMLDivElement> {
  rows: ToolRow[]
  diffs?: ToolDiff[]
  header?: string
  maxDiffs?: number
  defaultOpen?: boolean
}

export function ToolChips({ rows, diffs = [], header, maxDiffs = 4, defaultOpen = true, className, ...props }: ToolChipsProps) {
  const [open, setOpen] = React.useState(defaultOpen)
  const [openRows, setOpenRows] = React.useState<Set<string>>(new Set())
  const [allDiffs, setAllDiffs] = React.useState(false)
  const [preview, setPreview] = React.useState<{ id: string; x: number; top?: number; bottom?: number } | null>(null)

  const toggleRow = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const openPreview = (diff: ToolDiff) => (event: React.SyntheticEvent) => {
    if (!diff.lines?.length) return
    const rect = (event.currentTarget as Element).getBoundingClientRect()
    const height = 38 + diff.lines.length * 19
    const below = rect.bottom + 6 + height <= window.innerHeight - 12
    setPreview({
      id: diff.id,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
      ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 })
    })
  }
  const closePreview = (id: string) => () => setPreview((current) => (current?.id === id ? null : current))

  const shownDiffs = allDiffs ? diffs : diffs.slice(0, maxDiffs)
  const previewed = preview ? diffs.find((d) => d.id === preview.id) : undefined

  return (
    <div className={cn("w-full pb-1", className)} {...props}>
      {header && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
          <span className="tabular-nums">{header}</span>
        </button>
      )}

      <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}>
        <div className="-mx-1 min-h-0 overflow-hidden px-1.5 pb-1">
          <div className="mt-1 flex flex-col gap-1">
            {rows.map((row) => {
              const rowOpen = openRows.has(row.id)
              const expandable = !!(row.detail?.length || row.body)
              return (
                <div key={row.id} style={{ animation: "row-in 280ms var(--ease-out-strong) backwards", overflow: "clip", overflowClipMargin: 6 }}>
                  <button
                    type="button"
                    aria-expanded={expandable ? rowOpen : undefined}
                    disabled={!expandable}
                    onClick={() => toggleRow(row.id)}
                    className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 enabled:hover:bg-hover-2"
                  >
                    <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                      {row.status === "running" || row.status === "waiting" ? (
                        <span className="size-1.5 rounded-full bg-accent" style={{ animation: "pixel-on 900ms ease-in-out infinite" }} />
                      ) : (
                        <>
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill={row.icon === "think" ? "currentColor" : "none"}
                            stroke="currentColor"
                            className={cn(
                              "transition-opacity duration-100",
                              expandable && "group-hover/row:opacity-0",
                              rowOpen && "opacity-0",
                              row.status === "error" && "text-red"
                            )}
                          >
                            {ICONS[row.icon]}
                          </svg>
                          {expandable && (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className={cn("absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100", rowOpen ? "opacity-100" : "opacity-0")}
                              style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                            >
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          )}
                        </>
                      )}
                    </span>
                    <span className={cn("shrink-0 text-[12.5px] font-medium", row.status === "error" ? "text-ink-2" : "text-ink")}>{row.label}</span>
                    {row.chip && (
                      <span
                        className={cn(
                          "inline-flex h-5.5 min-w-0 items-center truncate rounded-chip bg-field px-1.5 text-[11.5px] text-ink-2 shadow-hairline",
                          row.mono && "font-mono"
                        )}
                      >
                        <span className="truncate">{row.chip}</span>
                      </span>
                    )}
                  </button>

                  {expandable && (
                    <div
                      className="grid transition-[grid-template-rows,opacity] duration-300"
                      style={{ gridTemplateRows: rowOpen ? "1fr" : "0fr", opacity: rowOpen ? 1 : 0, transitionTimingFunction: "var(--ease-out-strong)" }}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className="mt-0.5 mb-1 ml-2 flex min-w-0 flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
                          {row.detail?.map((line, i) => (
                            <span
                              key={i}
                              className={cn(
                                "truncate text-[11.5px] leading-[1.6]",
                                row.detailMono && "font-mono",
                                line.tone === "add" ? "text-green" : line.tone === "del" ? "text-red" : "text-ink-2"
                              )}
                            >
                              {line.text}
                            </span>
                          ))}
                          {rowOpen && row.body}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {diffs.length > 0 && (
            <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5">
              {shownDiffs.map((d, i) => (
                <span key={d.id} className="relative max-w-full" onMouseEnter={openPreview(d)} onMouseLeave={closePreview(d.id)}>
                  <button
                    type="button"
                    aria-label={`Open ${d.file}`}
                    onFocus={openPreview(d)}
                    onBlur={closePreview(d.id)}
                    onClick={d.onOpen}
                    className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn transition-colors duration-100 hover:bg-hover"
                    style={{ animation: `pop-in 250ms var(--ease-out-strong) ${i * 80}ms both` }}
                  >
                    <span className="min-w-0 truncate">{d.file}</span>
                    <span className="shrink-0 text-green tabular-nums">+{d.add}</span>
                    {d.del > 0 && <span className="shrink-0 text-red tabular-nums">−{d.del}</span>}
                  </button>
                </span>
              ))}
              {diffs.length > maxDiffs && !allDiffs && (
                <button
                  type="button"
                  onClick={() => setAllDiffs(true)}
                  className="inline-flex h-7 items-center rounded-chip px-1.5 font-mono text-[11.5px] text-ink-3 underline decoration-transparent underline-offset-2 transition-colors duration-100 hover:text-ink-2 hover:decoration-current"
                >
                  +{diffs.length - maxDiffs} more
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {preview &&
        previewed?.lines &&
        createPortal(
          <div
            className="fixed z-50 w-72 overflow-hidden rounded-[10px] bg-surface shadow-overlay"
            style={{
              left: preview.x,
              top: preview.top,
              bottom: preview.bottom,
              animation: "pop-in 160ms var(--ease-out-strong) both",
              transformOrigin: preview.top === undefined ? "bottom left" : "top left"
            }}
          >
            <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px]">
              <span className="min-w-0 truncate text-ink-2">{previewed.file}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-green">+{previewed.add}</span>
                {previewed.del > 0 && <span className="text-red"> −{previewed.del}</span>}
              </span>
            </div>
            <div className="max-h-64 overflow-hidden py-1 font-mono text-[11px] leading-[1.8]">
              {previewed.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex gap-2 px-2.5 whitespace-pre",
                    line.tone === "add" ? "bg-green-tint text-green" : line.tone === "del" ? "bg-red-tint text-red" : "text-ink-2"
                  )}
                >
                  <span className="w-3 shrink-0 select-none">{line.tone === "add" ? "+" : line.tone === "del" ? "−" : " "}</span>
                  <span className="min-w-0 truncate">{line.text}</span>
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
