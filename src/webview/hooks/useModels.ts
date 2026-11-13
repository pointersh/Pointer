import { EVENT_NAME } from "../../common/constants"
import { ModelCatalogue } from "../../common/types"
import { useServerState } from "../messaging"

const EMPTY: ModelCatalogue = {}

export const useModels = () => {
  const { data } = useServerState(EVENT_NAME.pointerGetModels, EMPTY)
  return { models: data ?? EMPTY }
}
