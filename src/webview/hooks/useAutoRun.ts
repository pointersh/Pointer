import { useCallback, useEffect, useRef, useState } from "react"

import { EVENT_NAME, GLOBAL_STORAGE_KEY } from "../../common/constants"
import { bridge } from "../messaging"

import { StorageType, useStorageContext } from "./useStorageContext"

export const useAutoRun = () => {
  const { context, setContext, loaded } = useStorageContext<boolean>(
    StorageType.Global,
    GLOBAL_STORAGE_KEY.autoRunCommands
  )
  const [setting, setSetting] = useState<string>("ask")
  const onRef = useRef(false)

  useEffect(() => {
    if (!loaded) return
    bridge
      .request(EVENT_NAME.pointerGetConfigValue, { key: "chatToolsCommands" })
      .then(({ value }) => typeof value === "string" && setSetting(value))
  }, [loaded])

  const available = setting !== "off"
  const on = available && (context ?? setting === "allow")
  onRef.current = on

  const toggle = useCallback(() => {
    setContext(!onRef.current)
  }, [setContext])

  const enable = useCallback(() => setContext(true), [setContext])

  return { autoRun: on, autoRunAvailable: available, toggleAutoRun: toggle, enableAutoRun: enable, setAutoRun: setContext }
}
