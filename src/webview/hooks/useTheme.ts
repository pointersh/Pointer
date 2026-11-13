import { EVENT_NAME } from "../../common/constants"
import { ThemeType } from "../../common/types"
import { useServerState } from "../messaging"

export const useTheme = (): ThemeType => {
  const { data } = useServerState(EVENT_NAME.pointerSendTheme, "Dark")
  return data ?? "Dark"
}
