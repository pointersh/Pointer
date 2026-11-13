import { Children, isValidElement, ReactNode, useMemo, useState } from "react"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"

import { ASSISTANT, EVENT_NAME } from "../common/constants"
import { LanguageType } from "../common/types"

import { useCodeTheme } from "./hooks/useCodeTheme"
import { emit } from "./messaging"
import { useTranslation } from "./strings"
import { getLanguageMatch } from "./utils"

import styles from "./styles/code-block.module.css"

interface CodeBlockProps {
  className?: string
  children?: ReactNode
  language?: LanguageType
  role: string | undefined
}

const COPIED_MS = 1500

const SHELL_FENCES = new Set([
  "bash",
  "sh",
  "shell",
  "shellscript",
  "zsh",
  "fish",
  "console",
  "terminal",
  "powershell",
  "pwsh",
  "ps1",
  "cmd",
  "bat",
  "batch"
])

const toText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(toText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return toText(node.props.children)
  }
  return Children.toArray(node).map(toText).join("")
}

interface ActionProps {
  icon: string
  label: string
  title: string
  onClick: () => void
  active?: boolean
}

const Action = ({ icon, label, title, onClick, active }: ActionProps) => (
  <button
    type="button"
    className={active ? `${styles.action} ${styles.actionActive}` : styles.action}
    title={title}
    aria-label={title}
    onClick={onClick}
  >
    <span className={`codicon codicon-${icon}`} aria-hidden="true" />
    <span className={styles.actionLabel}>{label}</span>
  </button>
)

export const CodeBlock = (props: CodeBlockProps) => {
  const { t } = useTranslation()
  const { children, language, className, role } = props
  const theme = useCodeTheme()
  const lang = getLanguageMatch(language, className)
  const [copied, setCopied] = useState(false)

  const code = useMemo(
    () => toText(children).replace(/^\n+/, "").replace(/\n$/, ""),
    [children]
  )

  const isShell = !!lang && SHELL_FENCES.has(lang.toLowerCase())
  const isAssistant = role === ASSISTANT

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), COPIED_MS)
  }

  const handleApply = () => emit(EVENT_NAME.pointerAcceptSolution, code)

  const handleNewDocument = () =>
    emit(EVENT_NAME.pointerNewDocument, { content: code, language: lang })

  const handleTerminal = () => emit(EVENT_NAME.pointerRunInTerminal, code)

  const handleInsert = () => emit(EVENT_NAME.pointerInsertAtCursor, code)

  if (!code.trim()) return null

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBar}>
        <span className={styles.codeLang}>{lang || t("code")}</span>
        <div className={styles.codeOptions}>
          {isAssistant && isShell && (
            <Action
              icon="terminal"
              label={t("action-terminal")}
              title={t("run-in-terminal")}
              onClick={handleTerminal}
            />
          )}
          {isAssistant && !isShell && (
            <Action
              icon="diff"
              label={t("action-apply")}
              title={t("apply-code")}
              onClick={handleApply}
            />
          )}
          {isAssistant && !isShell && (
            <Action
              icon="insert"
              label={t("action-insert")}
              title={t("insert-at-cursor")}
              onClick={handleInsert}
            />
          )}
          <Action
            icon={copied ? "check" : "copy"}
            label={copied ? t("action-copied") : t("action-copy")}
            title={copied ? t("copied-to-clipboard") : t("copy-code")}
            onClick={handleCopy}
            active={copied}
          />
          {isAssistant && (
            <Action
              icon="new-file"
              label={t("action-new-file")}
              title={t("new-document")}
              onClick={handleNewDocument}
            />
          )}
          <span className={styles.srOnly} role="status" aria-live="polite">
            {copied ? t("copied-to-clipboard") : ""}
          </span>
        </div>
      </div>
      <SyntaxHighlighter
        children={code}
        style={theme === "dark" ? vscDarkPlus : vs}
        language={lang || "text"}
        PreTag="pre"
      />
    </div>
  )
}

export default CodeBlock
