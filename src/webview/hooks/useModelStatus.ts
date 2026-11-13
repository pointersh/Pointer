import { useCallback, useEffect, useRef, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ModelStatus } from "../../common/model-status"
import { PointerProvider } from "../../common/types"
import { bridge } from "../messaging"

export const useModelStatus = (provider: PointerProvider | null, busy: boolean) => {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const asked = useRef(0)
  const key = provider ? `${provider.id}|${provider.modelName}` : ""

  const refresh = useCallback(() => {
    const mine = ++asked.current
    bridge
      .request(EVENT_NAME.pointerModelStatus)
      .then((value) => {
        if (mine === asked.current) setStatus(value)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!key) {
      setStatus(null)
      return
    }
    if (!busy) refresh()
  }, [key, busy, refresh])

  useEffect(() => {
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [refresh])

  const loading = !!status?.loading
  useEffect(() => {
    if (!loading) return
    const timer = setInterval(refresh, 1500)
    return () => clearInterval(timer)
  }, [loading, refresh])

  const warm = useCallback(() => {
    if (starting || loading) return
    const mine = ++asked.current
    setStarting(true)
    bridge
      .request(EVENT_NAME.pointerWarmModel)
      .then((value) => {
        if (mine === asked.current) setStatus(value)
        else refresh()
      })
      .catch(() => undefined)
      .finally(() => setStarting(false))
  }, [starting, loading, refresh])

  return { status, warming: starting || loading, warm }

}
