import { useCallback, useEffect, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ClientEventName } from "../../common/messaging/protocol"
import { bridge, useServerEvent } from "../messaging"

export enum StorageType {
  Global = "global",
  Session = "session",
  Workspace = "workspace"
}

const CHANNELS: Record<
  StorageType,
  { read: ClientEventName; write: ClientEventName }
> = {
  [StorageType.Global]: {
    read: EVENT_NAME.pointerGlobalContext,
    write: EVENT_NAME.pointerSetGlobalContext
  },
  [StorageType.Session]: {
    read: EVENT_NAME.pointerSessionContext,
    write: EVENT_NAME.pointerSetSessionContext
  },
  [StorageType.Workspace]: {
    read: EVENT_NAME.pointerGetWorkspaceContext,
    write: EVENT_NAME.pointerSetWorkspaceContext
  }
}

export const useStorageContext = <T>(storageType: StorageType, key: string) => {
  const [context, setContextState] = useState<T | undefined>()
  const [loaded, setLoaded] = useState(false)
  const { read, write } = CHANNELS[storageType]

  useEffect(() => {
    let cancelled = false
    bridge
      .request(read as typeof EVENT_NAME.pointerGlobalContext, { key })
      .then(({ value }) => {
        if (cancelled) return
        setContextState(value as T)
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [read, key])

  useServerEvent(
    read as typeof EVENT_NAME.pointerGlobalContext,
    useCallback(
      (update) => {
        if (update.key === key) setContextState(update.value as T)
      },
      [key]
    )
  )

  const setContext = useCallback(
    (value: T) => {
      setContextState(value)
      bridge.emit(write as typeof EVENT_NAME.pointerSetGlobalContext, {
        key,
        value
      })
    },
    [write, key]
  )

  return { context, setContext, loaded }
}
