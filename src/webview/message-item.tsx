import React, { memo } from "react"

import { WorkspaceSearchReport } from "../common/messaging/protocol"
import { ChatCompletionMessage, MentionType, ReplyChangesView, ToolStepView } from "../common/types"

import Message from "./message"
import TypingIndicator from "./typing-indicator"

interface MessageListProps {
  message: ChatCompletionMessage
  messages: ChatCompletionMessage[]
  completion?: ChatCompletionMessage | null
  pending?: boolean
  context?: WorkspaceSearchReport
  steps?: ToolStepView[]
  isLoading: boolean
  index: number
  generatingRef: React.RefObject<boolean>
  handleDeleteMessage: (index: number) => void
  handleEditMessage: (
    message: string,
    index: number,
    mentions: MentionType[] | undefined
  ) => void
  handleRegenerateMessage: (
    index: number,
    mentions: MentionType[] | undefined
  ) => void
  handleDeleteImage?: (id: string) => void
  handleContinue?: () => void
  handleChangesUpdate?: (index: number, changes: ReplyChangesView) => void
}

const MessageItem = memo(
  ({
    message,
    messages,
    completion,
    pending,
    context,
    steps,
    isLoading,
    index,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    handleDeleteImage,
    handleContinue,
    handleChangesUpdate
  }: MessageListProps) => {
    const isUserMessage = message?.role === "user"
    const isAgentMessage = message?.role === "assistant"
    const isLastMessage = index === messages?.length - 1
    const messageKey = `${message?.role}-0`
    const canContinue =
      isAgentMessage && isLastMessage && !isLoading && !!(message.meta?.stopped || message.meta?.outOfSteps)

    if (pending) {
      return completion ? (
        <Message
          key={`completion-${messageKey}`}
          isAssistant={true}
          message={completion}
          context={context}
          steps={steps}
          index={index}
          isLoading={isLoading}
          messages={messages}
          onDelete={handleDeleteMessage}
          onEdit={handleEditMessage}
          onRegenerate={handleRegenerateMessage}
          onDeleteImage={handleDeleteImage}
        />
      ) : (
        <TypingIndicator context={context} steps={steps} />
      )
    }

    return (
      <>
        {isUserMessage && (
          <Message
            key={messageKey}
            message={message}
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            onDeleteImage={handleDeleteImage}
          />
        )}
        {isAgentMessage && (
          <Message
            key={messageKey}
            message={message}
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            isAssistant
            onDeleteImage={handleDeleteImage}
            onContinue={canContinue ? handleContinue : undefined}
            onChangesUpdate={handleChangesUpdate}
          />
        )}
      </>
    )
  }
)

export default MessageItem
