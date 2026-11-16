import React, { useCallback, useEffect, useMemo, useRef } from "react"
import Markdown, { Components } from "react-markdown"
import DOMPurify from "dompurify"
import remarkGfm from "remark-gfm"

import { ASSISTANT, EVENT_NAME, POINTER, YOU } from "../common/constants"
import {
ChatCompletionMessage, ReplyMeta,
ToolStepView
} from "../common/types"

import { Button } from "./button"
import CodeBlock from "./codeBlock"
import { emit } from "./messaging"
import { replyParts } from "./replyParts"
import { useTranslation } from "./strings"
import { useToast } from "./toast"
import ToolSteps from "./toolSteps"
import { getThinkingMessage } from "./utils"

import styles from "./styles/message.module.css"

interface MessageProps {
  index?: number
  steps?: ToolStepView[]
  message?: ChatCompletionMessage
  onHeightChange?: () => void
  onContinue?: () => void
}

interface ThinkingSectionProps {
  thinking: string
  isCollapsed: boolean
  onToggle: () => void
  markdownComponents: Components
}

const ThinkingSection = React.memo(
  ({
    thinking,
    isCollapsed: initialCollapsed,
    onToggle,
    markdownComponents
  }: ThinkingSectionProps) => {
    const { t } = useTranslation()
    const [isCollapsed, setIsCollapsed] = React.useState(initialCollapsed)
    const prevThinkingRef = useRef(thinking)
    const isStreamingRef = useRef(false)

    useEffect(() => {
      if (thinking.length > prevThinkingRef.current.length) {
        isStreamingRef.current = true
        setIsCollapsed(false)
      } else {
        isStreamingRef.current = false
      }
      prevThinkingRef.current = thinking
    }, [thinking])

    const handleToggle = useCallback(() => {
      if (!isStreamingRef.current) {
        setIsCollapsed((prev) => !prev)
        onToggle()
      }
    }, [onToggle])

    return (
      <div className={styles.thinkingSection}>
        <div className={styles.thinkingHeader} onClick={handleToggle}>
          <span>{t("thinking")}</span>
          <span
            className={`codicon ${isCollapsed ? "codicon-chevron-right" : "codicon-chevron-down"
              }`}
          />
        </div>
        <div
          className={`${styles.thinkingContent} ${isCollapsed ? styles.collapsed : ""
            }`}
        >
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {thinking}
          </Markdown>
        </div>
      </div>
    )
  }
)

const formatDuration = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`

const compactCount = (count: number) =>
  count < 1000 ? String(count) : count < 10_000 ? `${(count / 1000).toFixed(1)}k` : `${Math.round(count / 1000)}k`

const CONTEXT_NEARLY_FULL = 0.8

const ReplyFooter = ({
  meta,
  onContinue,
  actions
}: {
  meta: ReplyMeta
  onContinue?: () => void
  actions?: React.ReactNode
}) => {
  const { t } = useTranslation()
  const parts: { text: string; title?: string }[] = []
  if (meta.durationMs !== undefined) parts.push({ text: formatDuration(meta.durationMs) })
  if (meta.completionTokens && meta.durationMs) {
    const perSecond = meta.completionTokens / (meta.durationMs / 1000)
    parts.push({
      text: t("reply-tokens-per-second", { count: meta.completionTokens, rate: perSecond.toFixed(1) }),
      title: t("reply-tokens-title", { count: meta.completionTokens })
    })
  }
  const title = [meta.provider, meta.model].filter(Boolean).join(" · ")
  const used = meta.promptTokens
  const holds = meta.contextWindow

  return (
    <div className={styles.replyFooter}>
      {meta.model && (
        <span className={styles.replyModel} title={title}>
          {meta.model}
        </span>
      )}
      {parts.map((part) => (
        <span key={part.text} title={part.title}>
          {part.text}
        </span>
      ))}
      {!!used && (
        <span
          className={holds && used / holds >= CONTEXT_NEARLY_FULL ? styles.replyContextFull : undefined}
          title={
            holds
              ? t("reply-context-of-title", { used: used.toLocaleString(), window: holds.toLocaleString() })
              : t("reply-context-title", { used: used.toLocaleString() })
          }
        >
          {holds
            ? t("reply-context-of", { used: compactCount(used), window: compactCount(holds) })
            : t("reply-context", { used: compactCount(used) })}
        </span>
      )}
      {meta.stopped && <span className={styles.replyStopped}>{t("reply-stopped")}</span>}
      {meta.outOfSteps && !meta.stopped && <span className={styles.replyStopped}>{t("reply-out-of-steps")}</span>}
      {!!meta.withheld?.length && <WithheldBadge withheld={meta.withheld} />}
      {!!meta.instructions?.length && <InstructionsBadge files={meta.instructions} />}
      {onContinue && (
        <button
          type="button"
          className={styles.replyContinue}
          onClick={onContinue}
          title={t(meta.outOfSteps && !meta.stopped ? "reply-continue-steps-title" : "reply-continue-title")}
        >
          <span className="codicon codicon-debug-continue" aria-hidden="true" />
          {t("reply-continue")}
        </button>
      )}
      {actions && <span className={styles.replyActions}>{actions}</span>}
    </div>
  )
}

const WithheldBadge = ({ withheld }: { withheld: NonNullable<ReplyMeta["withheld"]> }) => {
  const { t } = useTranslation()
  const count = withheld.reduce((sum, { count }) => sum + count, 0)
  const kinds = withheld.map(({ label, count }) => (count > 1 ? `${label} ×${count}` : label)).join(", ")
  return (
    <span className={styles.replyWithheld} title={t("reply-withheld-title", { kinds })}>
      <span className="codicon codicon-shield" aria-hidden="true" />
      {t("reply-withheld", { count })}
    </span>
  )
}

const InstructionsBadge = ({ files }: { files: string[] }) => {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className={styles.replyInstructions}
      title={t("reply-instructions-title", { files: files.join(", ") })}
      onClick={() => emit(EVENT_NAME.pointerOpenFile, { path: files[0] })}
    >
      <span className="codicon codicon-book" aria-hidden="true" />
      {files.length > 1 ? t("reply-instructions-more", { file: files[0], count: files.length - 1 }) : files[0]}
    </button>
  )
}

const COLLAPSE_HEIGHT = 240

const Collapsible = ({ children }: { children: React.ReactNode }) => {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [tall, setTall] = React.useState(false)
  const [open, setOpen] = React.useState(false)

  useEffect(() => {
    const el = ref.current
    if (el) setTall(el.scrollHeight > COLLAPSE_HEIGHT + 60)
  }, [children])

  return (
    <>
      <div
        ref={ref}
        className={tall && !open ? styles.folded : undefined}
        style={tall && !open ? { maxHeight: COLLAPSE_HEIGHT } : undefined}
      >
        {children}
      </div>
      {tall && (
        <button
          type="button"
          className={styles.expandToggle}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span
            className={`codicon codicon-chevron-${open ? "up" : "down"}`}
            aria-hidden="true"
          />
          {open ? t("show-less") : t("show-more")}
        </button>
      )}
    </>
  )
}

export const Message: React.FC<MessageProps> = ({
  index = 0,
  steps,
  message,
  onHeightChange,
  onContinue
}) => {
  const { t } = useTranslation()
  const [isThinkingCollapsed, setIsThinkingCollapsed] = React.useState(false)
  const messageRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef<number>(0)
  const { Toast, showToast } = useToast()
  const handleThinkingToggle = useCallback(() => {
    setIsThinkingCollapsed((prev) => !prev)
  }, [])
  useEffect(() => {
    const currentHeight = messageRef.current?.offsetHeight
    if (currentHeight && currentHeight !== prevHeightRef.current) {
      prevHeightRef.current = currentHeight
      onHeightChange?.()
    }
  }, [message?.content])

  const handleOpenFile = useCallback((filePath: string) => {
    emit(EVENT_NAME.pointerOpenFile, filePath)
  }, [])

  const renderContent = useCallback(
    (htmlContent: string) => {
      const sanitizedHtml = DOMPurify.sanitize(htmlContent, {
        ALLOWED_TAGS: ["span", "p", "br", "code", "pre"],
        ALLOWED_ATTR: ["class", "data-id", "data-label", "data-type"],
        ALLOW_DATA_ATTR: true,
        ALLOW_UNKNOWN_PROTOCOLS: true
      });

      return (
        <div
          className={styles.messageContent}
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
          onClick={(e) => {
            const target = e.target as HTMLElement
            const mention = target.closest(".mention")
            if (mention) {
              const filePath = mention.getAttribute("data-id")
              if (filePath) {
                handleOpenFile(filePath)
              }
            }
          }}
        />
      )
    },
    [handleOpenFile]
  )

  const renderCodeBlock = useCallback(
    ({
      children,
      ...props
    }: { children: React.ReactNode } & React.HTMLProps<HTMLPreElement>) => {
      if (React.isValidElement(children)) {
        return (
          <CodeBlock role={message?.role} {...children.props} />
        )
      }
      return <pre {...props}>{children}</pre>
    },
    [message?.role]
  )

  const markdownComponents = useMemo(
    () =>
    ({
      pre: renderCodeBlock,
      p: ({
        children,
        ...props
      }: React.HTMLAttributes<HTMLParagraphElement>) => {
        if (
          typeof children === "string" &&
          (children.includes("class=\"mention\"") || children.includes("<img"))
        ) {
          return renderContent(children)
        }
        return <p {...props}>{children}</p>
      },
    } as Components),
    [renderCodeBlock, renderContent]
  )

  if (!message) return null
  if (!message.content && !message.toolSteps?.length && !steps?.length) return null

  const { thinking, message: messageContent } = getThinkingMessage(
    message.content as string
  )

  const footerActions = message.role === ASSISTANT && !!message.meta

  const options = (
    <div className={styles.messageOptions}>
      <Button
        title={t("copy-code")}
        onClick={() => {
          navigator.clipboard.writeText(messageContent)
          showToast(t("copied-to-clipboard"))
        }}
        appearance="icon"
      >
        <span className="codicon codicon-copy"></span>
      </Button>
    </div>
  )

  return (
    <div
      ref={messageRef}
      className={
        message.role === ASSISTANT
          ? styles.message
          : `${styles.message} ${styles.userMessage}${index === 0 ? ` ${styles.firstMessage}` : ""}`
      }
    >
      {Toast}
      {thinking && (
        <ThinkingSection
          thinking={thinking}
          isCollapsed={isThinkingCollapsed}
          onToggle={handleThinkingToggle}
          markdownComponents={markdownComponents}
        />
      )}
      <div className={styles.messageRole}>
        <span className={styles.roleLabel}>
          {message.role !== ASSISTANT && (
            <span aria-hidden="true">
              &#10095;
            </span>
          )}
          {message.role === ASSISTANT ? POINTER : YOU}
        </span>
        {!footerActions && options}
      </div>
      {message.role === ASSISTANT ? (
        <>
          {replyParts(messageContent, message.toolSteps ?? steps).map((part, i) =>
            "steps" in part ? (
              <ToolSteps key={i} steps={part.steps} />
            ) : part.text.trim() ? (
              <Markdown key={i} remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {part.text.trim()}
              </Markdown>
            ) : null
          )}
          {message.meta && <ReplyFooter meta={message.meta} onContinue={onContinue} actions={footerActions ? options : undefined} />}
        </>
      ) : (
        <Collapsible>
          {renderContent(messageContent.trimStart())}
        </Collapsible>
      )}
    </div>
  )
}

export default Message
