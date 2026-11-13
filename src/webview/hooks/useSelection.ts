import { useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { bridge, useServerEvent } from "../messaging"

export const useSelection = (onSelect?: () => void) => {
  const [selection, setSelection] = useState("")

  useEffect(() => {
    let cancelled = false
    bridge.request(EVENT_NAME.pointerTextSelection).then((text) => {
      if (!cancelled) setSelection(text?.trim() || "")
    })
    return () => {
      cancelled = true
    }
  }, [])

  useServerEvent(EVENT_NAME.pointerTextSelection, (text) => {
    setSelection(text?.trim() || "")
    onSelect?.()
  })

  return selection
}
