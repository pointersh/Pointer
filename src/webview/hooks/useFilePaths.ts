import * as React from "react"

import { EVENT_NAME } from "../../common/constants"
import { useServerQuery } from "../messaging"

export const useFilePaths = () => {
  const { data, error, refetch } = useServerQuery(EVENT_NAME.pointerFileListRequest, [])
  // One retry if the first request fails or times out; callers refetch after files are created.
  const retried = React.useRef(false)
  React.useEffect(() => {
    if (error && !retried.current) {
      retried.current = true
      refetch()
    }
  }, [error, refetch])
  return { filePaths: data ?? [], refetch }
}
