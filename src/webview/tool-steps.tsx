import React, { useState } from "react"
import { Code } from "@pointersh/highlight/react"

import { EVENT_NAME } from "../common/constants"
import { ToolStepView } from "../common/types"

import { emit } from "./messaging"
import { useTranslation } from "./strings"
import { ToolOutput } from "./tool-output"
import { cx } from "./utils"

import styles from "./styles/tool-steps.module.css"

const STATUS_ICON: Record<ToolStepView["status"], string> = {
  running: "codicon-loading codicon-modifier-spin",
  waiting: "codicon-terminal",
  done: "codicon-check",
  failed: "codicon-error",
  skipped: "codicon-circle-slash",
  stopped: "codicon-debug-stop"
}

const LIVE_LINES = 8

const lastLines = (text: string, count: number) => text.trimEnd().split("\n").slice(-count).join("\n")

const Summary = ({ text }: { text: string }) => (
  <>
    {text.split(/(`[^`]+`)/).map((part, i) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      )
    )}
  </>
)

export const answerToolStep = (step: ToolStepView, how: "run" | "always" | "skip") =>
  emit(EVENT_NAME.pointerToolApproval, {
    id: step.id,
    run: how !== "skip",
    ...(how === "always" && step.approval !== "change" && !step.noAlways ? { always: true } : {})
  })

const Step = ({ step }: { step: ToolStepView }) => {
  const { t } = useTranslation()
  const waiting = step.status === "waiting"
  const [open, setOpen] = useState(false)
  const inspectable = !!step.output || !!Object.keys(step.args ?? {}).length
  const live = step.status === "running" && step.name === "run_command" && !!step.output?.trim()
  const finishedCommand =
    step.name === "run_command" && step.status !== "running" && step.status !== "waiting" ? step.args?.command?.trim() : undefined
  const [copied, setCopied] = useState(false)

  return (
    <li className={cx(styles.step, styles[step.status])}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.row}
          onClick={() => setOpen((prev) => !prev)}
          disabled={!inspectable || waiting}
          aria-expanded={open}
        >
          <span className={styles.glyph} aria-hidden="true">
            <span
              className={cx("codicon", waiting && step.approval === "change" ? "codicon-question" : STATUS_ICON[step.status])}
            />
          </span>
          <span className={styles.summary}>
            <Summary text={step.summary} />
          </span>
          {inspectable && !waiting && (
            <span
              className={cx("codicon", open ? "codicon-chevron-up" : "codicon-chevron-down", styles.chevron)}
              aria-hidden="true"
            />
          )}
        </button>
        {finishedCommand && (
          <>
            <button
              type="button"
              className={styles.stop}
              onClick={() => {
                void navigator.clipboard.writeText(finishedCommand).then(() => setCopied(true))
              }}
              title={t(copied ? "copied-to-clipboard" : "tool-copy-command")}
              aria-label={t("tool-copy-command")}
            >
              <span className={cx("codicon", copied ? "codicon-check" : "codicon-copy")} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.stop}
              onClick={() => emit(EVENT_NAME.pointerRunInTerminal, finishedCommand)}
              title={t("tool-command-to-terminal-title")}
              aria-label={t("tool-command-to-terminal")}
            >
              <span className="codicon codicon-terminal" aria-hidden="true" />
            </button>
          </>
        )}
        {step.stoppable && step.status === "running" && (
          <button
            type="button"
            className={styles.stop}
            onClick={() => emit(EVENT_NAME.pointerToolStop, { id: step.id })}
            title={t("tool-stop-title")}
            aria-label={t("tool-stop")}
          >
            <span className="codicon codicon-debug-stop" aria-hidden="true" />
          </button>
        )}
      </div>
      {waiting && (
        <div className={styles.approval}>
          <div className={styles.approvalLabel}>
            {t(step.approval === "change" ? "tool-change-waiting" : step.mcpTool ? "tool-mcp-waiting" : "tool-command-waiting")}
          </div>
          <div className={styles.command}>
            {step.approval === "change" || step.mcpTool ? (
              <pre className={styles.output}>{step.command}</pre>
            ) : (
              <Code code={step.command ?? ""} language="bash" />
            )}
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.run} onClick={() => answerToolStep(step, "run")}>
              <span className={cx("codicon", step.approval === "change" ? "codicon-check" : "codicon-play")} aria-hidden="true" />
              {t(step.approval === "change" ? "tool-apply" : "tool-run")}
            </button>
            {step.approval !== "change" && !step.noAlways && (
              <button
                type="button"
                className={styles.skip}
                title={t(step.mcpTool ? "tool-always-run-mcp-title" : "tool-always-run-title", { tool: step.mcpTool })}
                onClick={() => answerToolStep(step, "always")}
              >
                {t("tool-always-run")}
              </button>
            )}
            <button type="button" className={styles.skip} onClick={() => answerToolStep(step, "skip")}>
              {t("tool-skip")}
            </button>
          </div>
          <div className={styles.keys}>
            {t(step.approval === "change" ? "tool-change-keys" : step.noAlways ? "tool-command-keys-ask" : "tool-command-keys")}
          </div>
        </div>
      )}
      {live && !open && <pre className={styles.live}>{lastLines(step.output!, LIVE_LINES)}</pre>}
      {open && !waiting && (
        <div className={styles.detail}>
          <ToolOutput step={step} />
        </div>
      )}
    </li>
  )
}

const Said = ({ step }: { step: ToolStepView }) => {
  const { t } = useTranslation()
  return (
    <li className={styles.said}>
      <span className={styles.saidWho}>{t("tool-said")}</span>
      <span className={styles.saidText}>{step.summary}</span>
    </li>
  )
}

export const ToolSteps = ({ steps }: { steps?: ToolStepView[] }) => {
  if (!steps?.length) return null
  return (
    <ol className={styles.panel}>
      {steps.map((step) =>
        step.said ? <Said key={step.id} step={step} /> : <Step key={step.id} step={step} />
      )}
    </ol>
  )
}

export default ToolSteps
