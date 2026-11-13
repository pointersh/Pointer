import { useState } from "react"


import { EVENT_NAME, PROVIDER_EVENT_NAME, WEBUI_TABS } from "../common/constants"

import { Chat } from "./chat"
import { EmbeddingOptions } from "./embeddings"
import { ConversationHistory } from "./history"
import { useServerEvent } from "./messaging"
import { Providers } from "./providers"
import { Settings } from "./settings"

import styles from "./styles/main.module.css"

const tabs: Record<string, JSX.Element> = {
  [WEBUI_TABS.settings]: <Settings />,
  [WEBUI_TABS.embeddings]: <EmbeddingOptions />
}

interface MainProps {
  fullScreen?: boolean
}

export const Main = ({ fullScreen }: MainProps) => {
  const [tab, setTab] = useState<string | undefined>(WEBUI_TABS.chat)

  useServerEvent(EVENT_NAME.pointerSetTab, setTab)
  useServerEvent(PROVIDER_EVENT_NAME.focusProviderTab, setTab)

  if (!tab) {
    return null
  }

  const onChat = tab === WEBUI_TABS.chat
  const page =
    tab === WEBUI_TABS.history ? (
      <ConversationHistory onSelect={() => setTab(WEBUI_TABS.chat)} />
    ) : tab === WEBUI_TABS.providers ? (
      <Providers onDone={() => setTab(WEBUI_TABS.chat)} />
    ) : (
      tabs[tab]
    )

  return (
    <div>
      <div hidden={!onChat}>
        <Chat fullScreen={fullScreen} active={onChat} />
      </div>
      {!onChat && <div className={styles.page}>{page}</div>}
    </div>
  )
}
