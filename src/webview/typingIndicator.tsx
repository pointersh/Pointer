
import { POINTER } from "../common/constants"
import { ToolStepView } from "../common/types"

import ToolSteps from "./toolSteps"

import styles from "./styles/typingIndicator.module.css"

interface TypingIndicatorProps {
  steps?: ToolStepView[]
}

const TypingIndicator = ({ steps }: TypingIndicatorProps) => {
  return (
    <div className={styles.pending}>
      <div className={styles.label}>
        <span>{POINTER}</span>
        <span className={styles.cursor} aria-hidden="true" />
      </div>
      {!!steps?.length && (
        <div className={styles.context}>
          <ToolSteps steps={steps} />
        </div>
      )}
    </div>
  )
}

export default TypingIndicator
