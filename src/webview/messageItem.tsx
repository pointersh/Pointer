import { memo } from "react"

import { ChatCompletionMessage, ToolStepView } from "../common/types"

import Message from "./message"
import TypingIndicator from "./typingIndicator"

interface MessageListProps {
  message: ChatCompletionMessage
  messages: ChatCompletionMessage[]
  completion?: ChatCompletionMessage | null
  pending?: boolean
  steps?: ToolStepView[]
  isLoading: boolean
  index: number
  handleContinue?: () => void
}

const MessageItem = memo(
  ({ message, messages, completion, pending, steps, isLoading, index, handleContinue }: MessageListProps) => {
    if (pending) {
      return completion ? (
        <Message message={completion} steps={steps} index={index} />
      ) : (
        <TypingIndicator steps={steps} />
      )
    }
    const isAgentMessage = message?.role === "assistant"
    const canContinue =
      isAgentMessage && index === messages.length - 1 && !isLoading && !!(message.meta?.stopped || message.meta?.outOfSteps)
    if (!isAgentMessage) return message?.role === "user" ? <Message message={message} index={index} /> : null
    return (
      <Message
        message={message}
        index={index}
        onContinue={canContinue ? handleContinue : undefined}
      />
    )
  }
)

export default MessageItem
