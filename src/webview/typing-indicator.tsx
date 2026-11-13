import React from "react"

import { POINTER } from "../common/constants"
import { WorkspaceSearchReport } from "../common/messaging/protocol"
import { ToolStepView } from "../common/types"

import ToolSteps from "./tool-steps"
import WorkspaceContext from "./workspace-context"

import styles from "./styles/typing-indicator.module.css"

interface TypingIndicatorProps {
  context?: WorkspaceSearchReport
  steps?: ToolStepView[]
}

const TypingIndicator = ({ context, steps }: TypingIndicatorProps) => {
  return (
    <div className={styles.pending}>
      <div className={styles.label}>
        <span>{POINTER}</span>
        <span className={styles.cursor} aria-hidden="true" />
      </div>
      {context && (
        <div className={styles.context}>
          <WorkspaceContext report={context} />
        </div>
      )}
      {!!steps?.length && (
        <div className={styles.context}>
          <ToolSteps steps={steps} />
        </div>
      )}
    </div>
  )
}

export default TypingIndicator
