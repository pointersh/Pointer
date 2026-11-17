import * as React from "react"

import { cn } from "./cn"

export interface PointedChunk {
  path: string
  start: number
  end: number
  score: number
  reason: string
}

interface PointingAtProps extends React.HTMLAttributes<HTMLDivElement> {
  chunks: PointedChunk[]
  dropped?: string
  onOpen?: (chunk: PointedChunk) => void
}

export function PointingAt({ chunks, dropped, onOpen, className, ...props }: PointingAtProps) {
  const [all, setAll] = React.useState(false)
  const top = Math.max(...chunks.map((c) => c.score), 0.0001)
  const shown = all ? chunks : chunks.slice(0, 6)

  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)} {...props}>
      <div className="flex items-center gap-2 px-0.5" style={{ animation: "fade-in 300ms ease-out both" }}>
        <span className="text-[12.5px] font-semibold text-ink">Pointing at</span>
        <span className="inline-flex h-5 items-center rounded-md bg-inset px-1.5 text-[11px] font-medium text-ink-2 tabular-nums shadow-hairline">
          {chunks.length}
        </span>
        {dropped && <span className="min-w-0 truncate text-[11px] text-ink-3">{dropped}</span>}
      </div>
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        {shown.map((chunk, i) => {
          const name = chunk.path.split("/").pop() ?? chunk.path
          const dir = chunk.path.slice(0, chunk.path.length - name.length)
          return (
            <button
              key={`${chunk.path}:${chunk.start}`}
              type="button"
              onClick={() => onOpen?.(chunk)}
              className="group flex w-full flex-col gap-1 border-b border-line px-2.5 py-2 text-left transition-colors duration-100 last:border-b-0 hover:bg-hover"
              style={{ animation: `fade-up 300ms var(--ease-out-strong) ${i * 45}ms both` }}
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
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="h-1 w-10 overflow-hidden rounded-full bg-line">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(8, (chunk.score / top) * 100)}%` }} />
                  </span>
                  <span className="w-9 text-right font-mono text-[10.5px] text-ink-3 tabular-nums">{chunk.score.toFixed(3)}</span>
                </span>
              </span>
              <span className="line-clamp-2 text-[11.5px] leading-[1.45] text-ink-2">{chunk.reason}</span>
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
      </div>
    </div>
  )
}
