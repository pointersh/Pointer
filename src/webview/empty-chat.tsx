import React from "react"

import { useTranslation } from "./strings"

import styles from "./styles/chat.module.css"

export const EmptyChat = () => {
  const { t } = useTranslation()
  const title = t("empty-chat-title")
  return (
    <div className={styles.emptyChat}>
      <div className={styles.crt}>
        <div className={styles.crtGlyph} aria-hidden="true">
          &#10095;_
        </div>
        <h4 className={styles.crtTitle} style={{ "--chars": title.length } as React.CSSProperties}>
          <span className={styles.crtTyped}>{title}</span>
          <span className={styles.crtCursor} aria-hidden="true" />
        </h4>
      </div>
    </div>
  )
}
