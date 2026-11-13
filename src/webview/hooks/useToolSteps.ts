import { useCallback, useRef, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ToolStepView } from "../../common/types"
import { useServerEvent } from "../messaging"

export const useToolSteps = (replyText: () => string = () => "") => {
  const [steps, setSteps] = useState<ToolStepView[]>([])
  const stepsRef = useRef<ToolStepView[]>([])
  const atRef = useRef(new Map<string, number>())

  useServerEvent(EVENT_NAME.pointerToolSteps, (incoming) => {
    const marks = atRef.current
    stepsRef.current = (incoming ?? []).map((step) => {
      if (!marks.has(step.id)) marks.set(step.id, replyText().length)
      return { ...step, at: marks.get(step.id) }
    })
    setSteps(stepsRef.current)
  })

  const clear = useCallback(() => {
    stepsRef.current = []
    atRef.current = new Map()
    setSteps([])
  }, [])

  const take = useCallback(() => {
    const current = stepsRef.current
    clear()
    return current.length ? current : undefined
  }, [clear])

  return { steps, clear, take }
}
