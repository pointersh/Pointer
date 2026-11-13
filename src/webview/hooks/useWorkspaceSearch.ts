import { useCallback, useRef, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { WorkspaceSearchReport } from "../../common/messaging/protocol"
import { useServerEvent } from "../messaging"

const FINAL_STAGES = new Set(["done", "empty", "unavailable"])

export const isSearchFinished = (report: WorkspaceSearchReport | undefined) =>
  !!report && FINAL_STAGES.has(report.stage)

export const useWorkspaceSearch = () => {
  const [report, setReport] = useState<WorkspaceSearchReport | undefined>()
  const reportRef = useRef<WorkspaceSearchReport | undefined>()

  useServerEvent(EVENT_NAME.pointerWorkspaceSearch, (incoming) => {
    reportRef.current = incoming
    setReport(incoming)
  })

  const clear = useCallback(() => {
    reportRef.current = undefined
    setReport(undefined)
  }, [])

  const take = useCallback(() => {
    const current = reportRef.current
    clear()
    return isSearchFinished(current) ? current : undefined
  }, [clear])

  return { report, clear, take }
}
