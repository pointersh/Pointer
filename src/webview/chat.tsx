import React,{ useCallback,useEffect,useMemo,useRef,useState } from "react"
import { Virtuoso, VirtuosoHandle } from "react-virtuoso"
import Mention from "@tiptap/extension-mention"
import Placeholder from "@tiptap/extension-placeholder"
import { Editor, EditorContent, JSONContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { VSCodeButton, VSCodePanelView } from "@vscode/webview-ui-toolkit/react"
import * as cheerio from "cheerio"
import cx from "classnames"
import { v4 as uuidv4 } from "uuid"

import { ASSISTANT, EVENT_NAME, USER } from "../common/constants"
import {
AnyContextItem,
ChatCompletionMessage,
ImageAttachment,
MentionType,
ReplyChangesView,
ToolStepView
} from "../common/types"

import { useAgentMode } from "./hooks/useAgentMode"
import { useAutoRun } from "./hooks/useAutoRun"
import { useAutosizeTextArea } from "./hooks/useAutosizeTextArea"
import { useConversation } from "./hooks/useConversation"
import { useSelection } from "./hooks/useSelection"
import { useSuggestion } from "./hooks/useSuggestion"
import { useToolSteps } from "./hooks/useToolSteps"
import { useWorkspaceContext } from "./hooks/useWorkspaceContext"
import { useWorkspaceSearch } from "./hooks/useWorkspaceSearch"
import AgentSettings from "./agent-settings"
import { EmptyChat } from "./empty-chat"
import { createCustomImageExtension } from "./image-extension"
import MessageItem from "./message-item"
import { emit, useServerEvent } from "./messaging"
import { useTranslation } from "./strings"
import { answerToolStep } from "./tool-steps"
import { conversationMarkdown } from "./transcript"
import { CustomKeyMap, getThinkingMessage } from "./utils"

import styles from "./styles/chat.module.css"

const COMPOSER_MIN_HEIGHT = 44
const COMPOSER_HEIGHT_KEY = "pointer.composerHeight"
const PROMPT_HISTORY_KEY = "pointer.promptHistory"
const PROMPT_HISTORY_LIMIT = 50
const DOUBLE_ESCAPE_MS = 800
const KEY_OWNERS =
  "input, textarea, select, .ProseMirror, [contenteditable='true'], " +
  "vscode-text-field, vscode-text-area, vscode-dropdown"

const loadPromptHistory = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || "[]")
    return Array.isArray(stored) ? stored.filter((p) => typeof p === "string") : []
  } catch {
    return []
  }
}

interface QueuedMessage {
  id: string
  html: string
  input: string
  text: string
  mentions: MentionType[]
  images: ImageAttachment[]
  steer?: boolean
}

const steeringText = (input: string) =>
  cheerio
    .load(input.replace(/<br\s*\/?>/g, "\n"))
    .root()
    .text()
    .trim()

interface ChatProps {
  fullScreen?: boolean
  active?: boolean
}

export const Chat = (props: ChatProps): JSX.Element => {
  const { fullScreen, active = true } = props
  const generatingRef = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  const imagesRef = useRef<ImageAttachment[]>([])
  const stopRef = useRef(false)
  const selection = useSelection()
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [messages, setMessages] = useState<ChatCompletionMessage[]>([])
  const chatDisabled = false
  const [completion, setCompletion] = useState<ChatCompletionMessage | null>()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const { contextItems, removeContextItem } = useWorkspaceContext()
  const {
    report: searchReport,
    clear: clearSearchReport,
    take: takeSearchReport
  } = useWorkspaceSearch()
  const completionRef = useRef<ChatCompletionMessage | null | undefined>()
  completionRef.current = completion
  const { steps: toolSteps, clear: clearToolSteps, take: takeToolSteps } = useToolSteps(
    () => getThinkingMessage(String(completionRef.current?.content ?? "")).message
  )
  const [isBottom, setIsBottom] = useState(false)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const followRef = useRef(true)
  const [following, setFollowingState] = useState(true)
  const lastTopRef = useRef(0)
  const settleUntilRef = useRef(0)
  const setFollowing = useCallback((follow: boolean) => {
    followRef.current = follow
    setFollowingState(follow)
  }, [])
  const pinToEnd = useCallback(() => {
    if (!scroller) return
    scroller.scrollTop = scroller.scrollHeight
    lastTopRef.current = scroller.scrollTop
  }, [scroller])

  useEffect(() => {
    if (!scroller) return
    let intent = 0
    let dragging = false
    let repin = 0
    const meant = () => (intent = Date.now())
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) meant()
    }
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) meant()
    }
    const onDown = (event: MouseEvent) => {
      if (event.target === scroller) dragging = true
    }
    const onUp = () => {
      if (dragging) meant()
      dragging = false
    }
    const onScroll = () => {
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      const byReader = dragging || Date.now() - intent < 500
      if (byReader && scroller.scrollTop < lastTopRef.current - 1 && gap > 24) setFollowing(false)
      else if (gap <= 24 && !followRef.current) setFollowing(true)
      lastTopRef.current = scroller.scrollTop
      if (gap > 1 && followRef.current && !byReader && !repin) {
        repin = requestAnimationFrame(() => {
          repin = 0
          onResize()
        })
      }
    }
    const onResize = () => {
      if (!followRef.current) return
      if (!generatingRef.current && Date.now() > settleUntilRef.current) return
      scroller.scrollTop = scroller.scrollHeight
      lastTopRef.current = scroller.scrollTop
    }
    settleUntilRef.current = Date.now() + 1000
    onResize()
    const observer = new ResizeObserver(onResize)
    observer.observe(scroller)
    const list = scroller.querySelector("[data-testid=virtuoso-item-list]")
    if (list) observer.observe(list, { box: "border-box" })
    scroller.addEventListener("scroll", onScroll, { passive: true })
    scroller.addEventListener("wheel", onWheel, { passive: true })
    scroller.addEventListener("touchmove", meant, { passive: true })
    scroller.addEventListener("keydown", onKey)
    scroller.addEventListener("mousedown", onDown)
    window.addEventListener("mouseup", onUp)
    return () => {
      cancelAnimationFrame(repin)
      observer.disconnect()
      scroller.removeEventListener("scroll", onScroll)
      scroller.removeEventListener("wheel", onWheel)
      scroller.removeEventListener("touchmove", meant)
      scroller.removeEventListener("keydown", onKey)
      scroller.removeEventListener("mousedown", onDown)
      window.removeEventListener("mouseup", onUp)
    }
  }, [scroller, setFollowing])

  useEffect(() => {
    if (isLoading) {
      setFollowing(true)
      requestAnimationFrame(pinToEnd)
    } else {
      settleUntilRef.current = Date.now() + 1000
    }
  }, [isLoading, pinToEnd, setFollowing])
  const { agentMode, toggleAgentMode } = useAgentMode()
  const agentModeRef = useRef(agentMode)
  agentModeRef.current = agentMode
  const { autoRun, autoRunAvailable, toggleAutoRun, setAutoRun } = useAutoRun()
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const closeAgentSettings = useCallback(() => setAgentSettingsOpen(false), [])

  const { conversation, saveLastConversation, setActiveConversation } =
    useConversation()

  const chatRef = useRef<HTMLTextAreaElement>(null)
  const editorWrapRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const promptHistoryRef = useRef<string[]>(loadPromptHistory())
  const recallIndexRef = useRef(-1)
  const draftRef = useRef("")
  const [queued, setQueued] = useState<QueuedMessage[]>([])
  const queuedRef = useRef<QueuedMessage[]>([])
  const userStoppedRef = useRef(false)
  const lastEscapeRef = useRef(0)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const [hint, setHint] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY))
    return stored > 0 ? stored : null
  })

  const handleAddMessage = (added: ChatCompletionMessage | undefined) => {
    if (!added) {
      setCompletion(null)
      setIsLoading(false)
      generatingRef.current = false
      return
    }

    let incoming = added
    if (added.role === ASSISTANT) {
      const context = takeSearchReport()
      const steps = takeToolSteps()
      incoming = { ...added, ...(context ? { context } : {}), ...(steps ? { toolSteps: steps } : {}) }
    } else {
      clearSearchReport()
      clearToolSteps()
    }

    setMessages((prev) => {
      if (incoming.id) {
        const existingIndex = prev?.findIndex((m) => m.id === incoming.id)

        if (existingIndex !== -1) {
          const updatedMessages = [...(prev || [])]
          updatedMessages[existingIndex || 0] = incoming

          saveLastConversation({
            ...conversation,
            messages: updatedMessages
          })
          return updatedMessages
        }
      }

      const messages = [...(prev || []), incoming]
      saveLastConversation({
        ...conversation,
        messages: messages
      })
      return messages
    })

    setTimeout(() => {
      editorRef.current?.commands.focus()
      stopRef.current = false
    }, 200)

    setCompletion(null)
    setIsLoading(false)
  }

  useServerEvent(EVENT_NAME.pointerAddMessage, (incoming) => {
    generatingRef.current = true
    handleAddMessage(incoming)
  })

  useServerEvent(EVENT_NAME.pointerOnCompletion, (incoming) => {
    completionRef.current = incoming
    setCompletion(incoming)
  })

  useServerEvent(EVENT_NAME.pointerOnLoading, () => setIsLoading(true))

  useServerEvent(EVENT_NAME.pointerNewConversation, () => {
    updateQueue([])
    setMessages([])
    setCompletion(null)
    clearSearchReport()
    clearToolSteps()
    setActiveConversation({
      id: uuidv4(),
      title: t("chat-new-conversation-title"),
      messages: []
    })
    generatingRef.current = false
    setIsLoading(false)
    chatRef.current?.focus()
    setTimeout(() => {
      stopRef.current = false
    }, 1000)
  })

  useServerEvent(EVENT_NAME.pointerStopGeneration, () => {
    setIsLoading(false)
    setCompletion(null)
    stopRef.current = false
    generatingRef.current = false
    const stopped = userStoppedRef.current
    userStoppedRef.current = false
    const [next, ...rest] = queuedRef.current
    if (next && !stopped) {
      updateQueue(rest)
      setTimeout(() => sendRef.current(next), 0)
      return
    }
    if (next) restoreQueue()
    setTimeout(() => {
      chatRef.current?.focus()
    }, 200)
  })

  const updateQueue = (next: QueuedMessage[]) => {
    queuedRef.current = next
    setQueued(next)
  }

  useServerEvent(EVENT_NAME.pointerToolSteps, (incoming) => {
    const read = new Set((incoming ?? []).filter((step) => step.said).map((step) => step.id))
    if (!read.size) return
    const left = queuedRef.current.filter((message) => !read.has(`said.${message.id}`))
    if (left.length !== queuedRef.current.length) updateQueue(left)
  })

  const restoreQueue = () => {
    const editor = editorRef.current
    const waiting = queuedRef.current
    updateQueue([])
    if (!editor || !waiting.length) return
    const draft = editor.isEmpty ? "" : editor.getHTML()
    editor.commands.setContent(draft + waiting.map((message) => message.html).join(""), false)
    imagesRef.current = [...imagesRef.current, ...waiting.flatMap((message) => message.images)]
    editor.commands.focus("end")
  }

  const handleStopGeneration = useCallback(() => {
    userStoppedRef.current = true
    emit(EVENT_NAME.pointerStopGeneration)
  }, [])

  const handleRegenerateMessage = (
    index: number,
    mentions: MentionType[] | undefined
  ): void => {
    generatingRef.current = true
    setIsLoading(true)
    clearSearchReport()
    clearToolSteps()
    setMessages((prev) => {
      if (!prev) return prev
      const updatedMessages = prev.slice(0, index)

      emit(EVENT_NAME.pointerChatMessage, {
        messages: updatedMessages,
        mentions: mentions || [],
        conversationId: conversation?.id
      })

      return updatedMessages
    })
  }

  const handleDeleteMessage = (index: number): void => {
    setMessages((prev) => {
      if (!prev || prev.length === 0) return prev
      if (prev.length === 2) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        ...prev.slice(index + 2)
      ]

      saveLastConversation({
        ...conversation,
        messages: updatedMessages
      })

      return updatedMessages
    })
  }

  const handleChangesUpdate = useCallback(
    (index: number, changes: ReplyChangesView) => {
      setMessages((prev) => {
        if (!prev?.[index] || prev[index].changes?.id !== changes.id) return prev
        const updatedMessages = prev.map((message, i) => (i === index ? { ...message, changes } : message))
        saveLastConversation({ ...conversation, messages: updatedMessages })
        return updatedMessages
      })
    },
    [conversation, saveLastConversation]
  )

  const handleEditMessage = (
    message: string,
    index: number,
    mentions: MentionType[] | undefined,
    images?: ImageAttachment[]
  ): void => {
    generatingRef.current = true
    setIsLoading(true)
    clearSearchReport()
    clearToolSteps()
    setMessages((prev) => {
      if (!prev) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        {
          ...prev[index],
          content: message
            .replace(/<p>/g, "")
            .replace(/<\/p>/g, "<br>")
            .replace(/<br>$/, ""),
          images: images && images.length > 0 ? images : undefined,
          prompt: undefined
        }
      ]

      emit(EVENT_NAME.pointerChatMessage, {
        messages: updatedMessages,
        mentions: mentions || [],
        conversationId: conversation?.id
      })

      return updatedMessages
    })
  }

  const getMentions = useCallback(() => {
    const mentions: MentionType[] = []
    editorRef.current?.getJSON().content?.forEach((node) => {
      if (node.type === "paragraph" && Array.isArray(node.content)) {
        node.content.forEach((innerNode: JSONContent) => {
          if (innerNode.type === "mention" && innerNode.attrs) {
            mentions.push({
              name: innerNode.attrs.label,
              path: innerNode.attrs.id
            })
          }
        })
      }
    })

    return mentions
  }, [])

  const rememberPrompt = (html: string) => {
    const prompt = html.replace(/<img[^>]*>/g, "").trim()
    recallIndexRef.current = -1
    if (!prompt) return
    const history = promptHistoryRef.current.filter((p) => p !== prompt)
    history.push(prompt)
    promptHistoryRef.current = history.slice(-PROMPT_HISTORY_LIMIT)
    try {
      localStorage.setItem(
        PROMPT_HISTORY_KEY,
        JSON.stringify(promptHistoryRef.current)
      )
    } catch {}
  }

  const recallPrompt = useCallback((step: -1 | 1, isEmpty: boolean) => {
    const editor = editorRef.current
    const history = promptHistoryRef.current
    const index = recallIndexRef.current
    if (!editor || !history.length) return false
    if (index === -1 && (step === 1 || !isEmpty)) return false

    if (index === -1) draftRef.current = editor.getHTML()
    const next = Math.min(history.length - 1, index - step)
    if (next === index) return true
    recallIndexRef.current = next
    editor.commands.setContent(
      next === -1 ? draftRef.current : history[history.length - 1 - next],
      false
    )
    editor.commands.focus("end")
    return true
  }, [])

  const clearEditor = useCallback(() => {
    editorRef.current?.commands.clearContent()
  }, [])

  const clearDraft = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editor.isEmpty) return false
    rememberPrompt(editor.getHTML())
    imagesRef.current = []
    editor.commands.clearContent()
    return true
  }, [])

  const waitingStepRef = useRef<ToolStepView>()
  waitingStepRef.current = toolSteps.find((step) => step.status === "waiting")
  const approveWaiting = useCallback((how: "run" | "always" | "skip") => {
    const step = waitingStepRef.current
    if (!step) return false
    if (how === "always" && (step.approval !== "command" || step.noAlways)) return false
    answerToolStep(step, how)
    return true
  }, [])

  const stopIfGenerating = useCallback(() => {
    if (!generatingRef.current) return false
    userStoppedRef.current = true
    emit(EVENT_NAME.pointerStopGeneration)
    return true
  }, [])

  const handleEscape = useCallback(() => {
    if (approveWaiting("skip")) return true
    if (stopIfGenerating()) return true
    const editor = editorRef.current
    if (!editor || editor.isEmpty) return false

    clearTimeout(hintTimerRef.current)
    if (Date.now() - lastEscapeRef.current < DOUBLE_ESCAPE_MS) {
      lastEscapeRef.current = 0
      setHint(null)
      return clearDraft()
    }
    lastEscapeRef.current = Date.now()
    setHint(t("shortcuts-esc-again"))
    hintTimerRef.current = setTimeout(() => setHint(null), DOUBLE_ESCAPE_MS)
    return true
  }, [approveWaiting, clearDraft, stopIfGenerating, t])

  const handleInterrupt = useCallback(() => {
    if (!window.getSelection()?.isCollapsed) return false
    return stopIfGenerating() || clearDraft()
  }, [clearDraft, stopIfGenerating])

  const scrollTranscript = useCallback((direction: -1 | 1) => {
    if (direction < 0) setFollowing(false)
    virtuosoRef.current?.scrollBy({
      top: direction * window.innerHeight * 0.6
    })
    return true
  }, [])

  useEffect(() => () => clearTimeout(hintTimerRef.current), [])

  const sendMessage = (message: QueuedMessage) => {
    generatingRef.current = true
    setIsLoading(true)
    clearSearchReport()
    clearToolSteps()

    const conversationId = conversation?.id || uuidv4()

    setMessages((prevMessages) => {
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prevMessages || []),
        {
          role: USER,
          content: message.input,
          images: message.images.length > 0 ? message.images : undefined
        }
      ]

      const currentConversation = {
        id: conversationId,
        messages: updatedMessages,
        title: conversation?.title || t("chat-new-conversation-title")
      }

      saveLastConversation(currentConversation)
      setActiveConversation(currentConversation)

      emit(EVENT_NAME.pointerChatMessage, {
        messages: updatedMessages,
        mentions: message.mentions,
        conversationId
      })

      return updatedMessages
    })
  }
  const sendRef = useRef(sendMessage)
  sendRef.current = sendMessage

  const handleSubmitForm = useCallback(() => {
    const html = editorRef.current?.getHTML() || ""
    const input = html
      .replace(/<p>/g, "")
      .replace(/<\/p>/g, "<br>")
      .replace(/<br>$/, "")

    const text = cheerio
      .load(input || "")
      .root()
      .text()
      .trim()

    if (!text || !input || chatDisabled) return

    const message: QueuedMessage = {
      id: uuidv4(),
      html,
      input,
      text,
      mentions: getMentions(),
      images: imagesRef.current
    }
    imagesRef.current = []
    clearEditor()
    rememberPrompt(html)

    if (generatingRef.current) {
      const steer = agentModeRef.current && !message.mentions.length && !message.images.length
      updateQueue([...queuedRef.current, { ...message, steer }])
      if (steer) emit(EVENT_NAME.pointerSteer, { id: message.id, text: steeringText(input) })
      return
    }
    sendRef.current(message)
  }, [chatDisabled])

  const handleContinue = useCallback(() => {
    if (generatingRef.current || chatDisabled) return
    generatingRef.current = true
    setIsLoading(true)
    clearSearchReport()
    clearToolSteps()
    setMessages((prev) => {
      const last = prev?.[prev.length - 1]
      const outOfSteps = !!last?.meta?.outOfSteps && !last.meta.stopped
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prev || []),
        {
          role: USER,
          content: t("reply-continue"),
          prompt: outOfSteps
            ? "Carry on with the task from where your last reply got to, using the tools again as you need them. " +
              "Do not redo steps that already worked."
            : "Continue exactly where your last reply stopped. " +
              "Do not repeat anything you already wrote."
        }
      ]
      saveLastConversation({ ...conversation, messages: updatedMessages })
      emit(EVENT_NAME.pointerChatMessage, {
        messages: updatedMessages,
        mentions: [],
        conversationId: conversation?.id
      })
      return updatedMessages
    })
  }, [conversation, chatDisabled, clearSearchReport, clearToolSteps, t])

  const handleOpenAsMarkdown = useCallback(() => {
    if (!messages.length) return
    emit(EVENT_NAME.pointerNewDocument, {
      content: conversationMarkdown(conversation?.title, messages),
      language: "markdown"
    })
  }, [conversation?.title, messages])

  useServerEvent(EVENT_NAME.pointerExportConversation, handleOpenAsMarkdown)

  const handleNewConversation = useCallback(() => {
    setActiveConversation({
      id: uuidv4(),
      title: t("chat-new-conversation-title"),
      messages: []
    })

    emit(EVENT_NAME.pointerNewConversation)
  }, [setActiveConversation, t])

  const newConversationRef = useRef(handleNewConversation)
  newConversationRef.current = handleNewConversation

  const startNewConversation = useCallback(() => {
    stopIfGenerating()
    newConversationRef.current()
    return true
  }, [stopIfGenerating])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest(KEY_OWNERS)) return

      let handled = false
      if (e.ctrlKey) {
        if (e.shiftKey) return
        if (e.key === "c") {
          handled = handleInterrupt()
        } else if (e.key === "l") {
          handled = startNewConversation()
        }
      } else if (e.key === "Escape") {
        handled = handleEscape()
      } else if (e.key.length === 1 && e.key !== " " && !chatDisabled) {
        if (!target?.closest("button, vscode-button, a, summary")) {
          editorRef.current?.commands.focus("end")
        }
      }
      if (handled) e.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    active,
    chatDisabled,
    handleEscape,
    handleInterrupt,
    startNewConversation
  ])

  const handleOpenFile = useCallback((filePath: string) => {
    emit(EVENT_NAME.pointerOpenFile, filePath)
  }, [])

  useEffect(() => {
    if (!active) return
    editorRef.current?.commands.focus()
  }, [active])

  useEffect(() => {
    if (editorRef.current) emit(EVENT_NAME.pointerSidebarReady)
  }, [editorRef.current])

  useEffect(() => {
    editorRef.current?.commands.focus()
  }, [])

  useEffect(() => {
    if (conversation?.id) setMessages(conversation.messages || [])
    if (queuedRef.current.length) updateQueue([])
    setFollowing(true)
    settleUntilRef.current = Date.now() + 1000
  }, [conversation?.id])

  const { suggestion, filePaths } = useSuggestion()

  const memoizedSuggestion = useMemo(
    () => suggestion,
    [JSON.stringify(filePaths)]
  )

  const CustomImageExtension = createCustomImageExtension((id: string) => {
    imagesRef.current = imagesRef.current.filter((img) => img.id !== id)
  })

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Mention.configure({
          HTMLAttributes: {
            class: "mention"
          },
          suggestion: memoizedSuggestion,
          renderText({ node }) {
            return node.attrs.label
          }
        }),
        CustomImageExtension.configure({
          allowBase64: true
        }),
        CustomKeyMap.configure({
          handleSubmitForm,
          clearEditor,
          recallPrompt,
          escape: handleEscape,
          approve: approveWaiting,
          interrupt: handleInterrupt,
          newConversation: startNewConversation,
          toggleAgentMode,
          scrollTranscript
        }),
        Placeholder.configure({
          placeholder: t("placeholder"),
          showOnlyWhenEditable: false
        })
      ],
      onUpdate: () => {
        recallIndexRef.current = -1
        lastEscapeRef.current = 0
      }
    },
    [
      memoizedSuggestion,
      handleSubmitForm,
      clearEditor,
      recallPrompt,
      handleEscape,
      handleInterrupt,
      startNewConversation,
      t,
      imagesRef
    ]
  )

  useEffect(() => {
    editor?.setEditable(!chatDisabled)
  }, [editor, chatDisabled])

  const handleImageUpload = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const base64 = e.target?.result as string
        const imageData = base64.startsWith("data:")
          ? base64
          : `data:${file.type};base64,${base64.split(",").pop()}`
        const id = crypto.randomUUID()
        const newImage = { id, data: imageData, type: file.type }

        imagesRef.current = [...imagesRef.current, newImage]

        const { state } = editor?.view || {}

        if (state) {
          if (
            state.selection.empty &&
            state.selection.$head.pos === state.doc.content.size
          ) {
            editor?.chain().focus().createParagraphNear().run()
          }

          editor
            ?.chain()
            .focus()
            .insertContent({
              type: "image",
              attrs: { src: imageData, id }
            })
            .run()

          editor?.chain().focus().createParagraphNear().run()
        } else {
          editor
            ?.chain()
            .focus()
            .insertContent({
              type: "image",
              attrs: { src: imageData, id }
            })
            .run()
        }
      }
      reader.readAsDataURL(file)
    },
    [editor]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer.files).filter((file) =>
        file.type.startsWith("image/")
      )
      files.forEach(handleImageUpload)
    },
    [handleImageUpload]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLFormElement>) => {
      const items = Array.from(e.clipboardData?.items || [])
      const imageItem = items.find((item) => item.type.startsWith("image/"))

      if (imageItem) {
        e.preventDefault()
        const file = imageItem.getAsFile()
        if (file) handleImageUpload(file)
        return
      }
    },
    [handleImageUpload]
  )

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter((file) =>
        file.type.startsWith("image/")
      )
      files.forEach(handleImageUpload)
      e.target.value = ""
    },
    [handleImageUpload]
  )

  const handleDeleteImage = (id: string) => {
    imagesRef.current = imagesRef.current.filter((img) => img.id !== id)
  }

  useAutosizeTextArea(chatRef, editorRef.current?.getText() || "")

  useEffect(() => {
    if (editor) editorRef.current = editor
    editorRef.current?.commands.focus()
  }, [editor])

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.extensionManager.extensions.forEach((extension) => {
        if (extension.name === "mention") {
          extension.options.suggestion = memoizedSuggestion
        }
      })
    }
  }, [memoizedSuggestion])

  useEffect(() => {
    if (composerHeight === null) {
      localStorage.removeItem(COMPOSER_HEIGHT_KEY)
      return
    }
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight))
  }, [composerHeight])

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wrap = editorWrapRef.current
      if (!wrap) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      resizeRef.current = {
        startY: e.clientY,
        startHeight: wrap.getBoundingClientRect().height
      }
    },
    []
  )

  const handleResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const resize = resizeRef.current
      if (!resize) return
      const max = Math.max(COMPOSER_MIN_HEIGHT, window.innerHeight - 140)
      const height = resize.startHeight + (resize.startY - e.clientY)
      setComposerHeight(Math.min(max, Math.max(COMPOSER_MIN_HEIGHT, height)))
    },
    []
  )

  const handleComposerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      if (target.closest("button, input, a, .ProseMirror")) return
      e.preventDefault()
      editorRef.current?.commands.focus("end")
    },
    []
  )

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!resizeRef.current) return
      resizeRef.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
    },
    []
  )

  const scrollToBottom = useCallback(() => {
    setFollowing(true)
    virtuosoRef.current?.scrollTo({
      top: Infinity,
      behavior: "auto"
    })
    pinToEnd()
  }, [pinToEnd, setFollowing])

  const renderContextItem = useCallback(
    (item: AnyContextItem) => {
      let codicon = ""
      const displayName = item.name
      const title =
        "selectionRange" in item
          ? `${item.path} (lines ${item.selectionRange.startLine + 1}-${
              item.selectionRange.endLine + 1
            })`
          : item.path

      if (item.category === "files") {
        codicon = "codicon codicon-file-code"
      } else if (item.category === "selection") {
        codicon = "codicon codicon-symbol-snippet"
      }

      return (
        <div
          key={item.id}
          title={title}
          className={styles.contextItem}
          onClick={() => handleOpenFile(item.path)}
        >
          <span className={`${codicon} ${styles.contextItemIcon}`}></span>
          <span className={styles.contextItemName}>{displayName}</span>
          <span
            onClick={(e) => {
              e.stopPropagation()
              removeContextItem(item.id)
            }}
            data-id={item.id}
            className={cx("codicon codicon-close", styles.contextItemClose)}
          />
        </div>
      )
    },
    [handleOpenFile, removeContextItem]
  )

  const pending = isLoading || !!completion
  const itemContent = useCallback(
    (index: number) => (
      <MessageItem
        key={`message-list-${index}`}
        pending={index >= messages.length}
        completion={completion}
        context={searchReport}
        steps={toolSteps}
        generatingRef={generatingRef}
        handleDeleteImage={handleDeleteImage}
        handleDeleteMessage={handleDeleteMessage}
        handleEditMessage={handleEditMessage}
        handleRegenerateMessage={handleRegenerateMessage}
        handleContinue={handleContinue}
        handleChangesUpdate={handleChangesUpdate}
        index={Math.min(index, messages.length - 1)}
        isLoading={isLoading}
        message={messages[Math.min(index, messages.length - 1)]}
        messages={messages}
      />
    ),
    [
      handleDeleteMessage,
      handleEditMessage,
      handleRegenerateMessage,
      handleContinue,
      handleChangesUpdate,
      isLoading,
      messages,
      completion,
      searchReport,
      toolSteps,
      generatingRef
    ]
  )

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        {!!fullScreen && (
          <div className={styles.fullScreenActions}>
            <VSCodeButton
              onClick={handleNewConversation}
              appearance="icon"
              title={t("new-conversation")}
            >
              <i className="codicon codicon-comment-discussion" />
            </VSCodeButton>
            <VSCodeButton
              onClick={handleOpenAsMarkdown}
              appearance="icon"
              disabled={!messages.length}
              title={t("open-as-markdown")}
            >
              <i className="codicon codicon-markdown" />
            </VSCodeButton>
          </div>
        )}
        {!!contextItems.length && (
          <div className={styles.contextItems}>
            {contextItems.map(renderContextItem)}
          </div>
        )}
        <div className={styles.transcript}>
          {messages.length === 0 ? (
            <EmptyChat />
          ) : (
            <Virtuoso
              style={{ height: "100%" }}
              ref={virtuosoRef}
              scrollerRef={(element) => setScroller(element instanceof HTMLElement ? element : null)}
              totalCount={messages.length + (pending ? 1 : 0)}
              defaultItemHeight={800}
              itemContent={itemContent}
              atBottomThreshold={20}
              atBottomStateChange={(bottom) => setIsBottom(bottom)}
              alignToBottom
            />
          )}
        </div>
        <div className={styles.chatOptions}>
          <div>
            {!isBottom && messages.length > 0 && !(following && isLoading) && (
              <VSCodeButton
                appearance="icon"
                className={styles.scrollDown}
                onClick={scrollToBottom}
                title={t("scroll-to-bottom")}
              >
                <i className="codicon codicon-arrow-down" />
              </VSCodeButton>
            )}
          </div>
          {hint ? (
            <span className={styles.selectionCount}>{hint}</span>
          ) : (
            !!selection.length && (
              <span className={styles.selectionCount}>
                {t("selection-chars", { chars: selection.length })}
              </span>
            )
          )}
        </div>
        <div className={cx(styles.composer, { [styles.agentBusy]: agentMode && (isLoading || generatingRef.current) })}>
          {agentMode && agentSettingsOpen && (
            <AgentSettings autoRun={autoRun} setAutoRun={setAutoRun} onClose={closeAgentSettings} />
          )}
          {!!queued.length && (
            <ol className={styles.queue} aria-label={t("queued-title")}>
              {queued.map((message) => (
                <li key={message.id} className={styles.queued}>
                  <span
                    className={styles.queuedLabel}
                    title={message.steer ? t("queued-steer-title") : undefined}
                  >
                    {t(message.steer ? "queued-steer" : "queued")}
                  </span>
                  <span className={styles.queuedText} title={message.text}>
                    {message.text}
                  </span>
                  <button
                    type="button"
                    className={styles.queuedRemove}
                    onClick={() => {
                      if (message.steer) emit(EVENT_NAME.pointerSteer, { id: message.id })
                      updateQueue(queuedRef.current.filter((entry) => entry.id !== message.id))
                    }}
                    title={t("queued-remove")}
                    aria-label={t("queued-remove")}
                  >
                    <i className="codicon codicon-close" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div
            role="separator"
            aria-orientation="horizontal"
            title={t("resize-composer")}
            className={styles.resizeHandle}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={() => setComposerHeight(null)}
          >
            <span className={styles.resizeGrip} />
          </div>
          <form onDrop={handleDrop} onPaste={handlePaste}>
            <div
              className={cx(styles.chatBox, {
                [styles.chatBoxDisabled]: chatDisabled,
                [styles.agent]: agentMode
              })}
              title={chatDisabled ? t("chat-disabled-no-provider") : undefined}
              onMouseDown={handleComposerMouseDown}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="image/*"
                multiple
                style={{ display: "none" }}
              />
              <span className={styles.prompt} aria-hidden="true">
                {agentMode ? <>&#10095;&#10095;</> : <>&#10095;</>}
              </span>
              <div
                ref={editorWrapRef}
                className={styles.editorWrap}
                style={
                  composerHeight === null
                    ? undefined
                    : { height: composerHeight, maxHeight: composerHeight }
                }
              >
                <EditorContent
                  className={styles.tiptap}
                  editor={editorRef.current}
                />
              </div>
              <div className={styles.modeSwitches}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={agentMode}
                  disabled={chatDisabled}
                  className={cx(styles.agentToggle, { [styles.agentToggleOn]: agentMode })}
                  onClick={toggleAgentMode}
                  title={t(agentMode ? "agent-mode-on-title" : "agent-mode-off-title")}
                >
                  <span className={styles.agentDot} aria-hidden="true" />
                  {t(agentMode ? "agent-mode-on" : "agent-mode")}
                  <span className={styles.switchKey}>{t("agent-mode-key")}</span>
                </button>
                {agentMode && autoRunAvailable && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoRun}
                    disabled={chatDisabled}
                    className={cx(styles.agentToggle, { [styles.agentToggleOn]: autoRun })}
                    onClick={toggleAutoRun}
                    title={t(autoRun ? "auto-run-on-title" : "auto-run-off-title")}
                  >
                    <span className="codicon codicon-terminal" aria-hidden="true" />
                    <span className={styles.switchLabel}>{t("auto-run")}</span>
                  </button>
                )}
                {agentMode && (
                  <button
                    type="button"
                    data-agent-settings-toggle
                    aria-expanded={agentSettingsOpen}
                    className={cx(styles.agentToggle, { [styles.agentToggleOn]: agentSettingsOpen })}
                    onClick={() => {
                      setAgentSettingsOpen((open) => !open)
                    }}
                    title={t("agent-settings-title")}
                    aria-label={t("agent-settings-title")}
                  >
                    <span className="codicon codicon-settings-gear" aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className={styles.chatButtons}>
                <VSCodeButton
                  appearance="icon"
                  role="button"
                  disabled={chatDisabled}
                  onClick={handleFileSelect}
                  title={t("upload-image")}
                >
                  <span className="codicon codicon-device-camera" />
                </VSCodeButton>
                {generatingRef.current ? (
                  <VSCodeButton
                    appearance="icon"
                    role="button"
                    className={cx(styles.sendButton, styles.stopButton)}
                    onClick={handleStopGeneration}
                    title={t("stop-generation-esc")}
                    aria-label={t("stop-generation")}
                  >
                    <span className="codicon codicon-debug-stop"></span>
                  </VSCodeButton>
                ) : (
                  <VSCodeButton
                    appearance="icon"
                    role="button"
                    disabled={chatDisabled}
                    className={styles.sendButton}
                    onClick={handleSubmitForm}
                    title={t("send")}
                  >
                    <span className="codicon codicon-arrow-up"></span>
                  </VSCodeButton>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>
    </VSCodePanelView>
  )
}
