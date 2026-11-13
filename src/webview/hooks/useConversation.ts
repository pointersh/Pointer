import { useState } from "react"

import { Conversation } from "../../common/types"

export const useConversation = () => {
  const [conversation, setActiveConversation] = useState<Conversation>()
  return { conversation, setActiveConversation, saveLastConversation: setActiveConversation }
}
