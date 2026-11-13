import { EVENT_NAME } from "../../common/constants"
import { useServerQuery } from "../messaging"

export const useFilePaths = () => {
  const { data } = useServerQuery(EVENT_NAME.pointerFileListRequest, [])
  return { filePaths: data ?? [] }
}
