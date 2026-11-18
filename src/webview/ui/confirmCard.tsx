import * as React from "react"

import { cn } from "./cn"

interface ConfirmCardProps extends React.HTMLAttributes<HTMLDivElement> {
  question: string
  target: string
  mono?: boolean
  confirmLabel: string
  onConfirm: () => void
  onSkip: () => void
  onAlways?: () => void
}

export function ConfirmCard({ question, target, mono = true, confirmLabel, onConfirm, onSkip, onAlways, className, ...props }: ConfirmCardProps) {
  // No autofocus: the user may be typing, and a stray Space or Enter must never approve. Enter and Esc are handled by the panel.
  return (
    <div
      role="alertdialog"
      aria-label={question}
      className={cn("w-full overflow-hidden rounded-card bg-surface shadow-card", className)}
      style={{ animation: "pop-in 200ms var(--ease-out-strong) both" }}
      {...props}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <span className="mt-[3px] flex size-1.5 shrink-0 rounded-full bg-orange" style={{ animation: "pixel-on 1.2s ease-in-out infinite" }} />
        <span className="min-w-0 flex-1 text-[13px] font-semibold text-ink">{question}</span>
      </div>
      <div className="px-3 pt-2 pb-2.5">
        <div className={cn("max-h-28 overflow-auto rounded-chip bg-inset px-2 py-1.5 text-[12px] leading-[1.55] text-ink shadow-hairline [overflow-wrap:anywhere]", mono && "font-mono")}>
          {target}
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate pl-1 text-[11px] text-ink-3">
          <kbd className="font-sans">Enter</kbd> {confirmLabel.toLowerCase()} · <kbd className="font-sans">Esc</kbd> skip
        </span>
        <button
          type="button"
          onClick={onSkip}
          className="h-7 rounded-full bg-hover px-3 text-[12.5px] font-medium text-ink transition-[background-color,transform] duration-150 hover:bg-hover-2 active:scale-[0.96]"
        >
          Skip
        </button>
        {onAlways && (
          <button
            type="button"
            onClick={onAlways}
            className="h-7 rounded-full px-3 text-[12.5px] font-medium text-ink-2 shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.96]"
          >
            Always
          </button>
        )}
        <button
          type="button"
          onClick={onConfirm}
          className="h-7 rounded-full bg-accent px-3.5 text-[12.5px] font-medium text-[var(--vscode-button-foreground)] transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.96]"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}
