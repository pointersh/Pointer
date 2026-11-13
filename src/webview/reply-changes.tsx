import React, { useState } from "react"
import { useTranslation } from "./strings"
import cx from "classnames"

import { EVENT_NAME } from "../common/constants"
import { FileChangeView, ReplyChangesView } from "../common/types"

import { bridge, emit } from "./messaging"

import styles from "./styles/reply-changes.module.css"

const OPEN_UP_TO = 6

const undoable = (file: FileChangeView) => !file.undone && !file.noUndo

const Counts = ({ added, removed }: { added: number; removed: number }) => (
  <span className={styles.counts}>
    {added > 0 && <span className={styles.added}>+{added}</span>}
    {removed > 0 && <span className={styles.removed}>−{removed}</span>}
  </span>
)

interface ReplyChangesProps {
  changes: ReplyChangesView
  onUpdate?: (changes: ReplyChangesView) => void
  onError?: (message: string) => void
}

export const ReplyChanges = ({ changes, onUpdate, onError }: ReplyChangesProps) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(changes.files.length <= OPEN_UP_TO)
  const [busy, setBusy] = useState(false)
  const totals = changes.files.reduce(
    (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
    { added: 0, removed: 0 }
  )
  const left = changes.files.filter(undoable)
  const allUndone = changes.files.some((file) => file.undone) && changes.files.every((file) => file.undone || file.noUndo)

  const undo = async (paths?: string[]) => {
    if (busy) return
    setBusy(true)
    try {
      const answer = await bridge.request(EVENT_NAME.pointerUndoChanges, { id: changes.id, ...(paths ? { paths } : {}) })
      if (answer?.view) onUpdate?.(answer.view)
      if (answer?.error) onError?.(answer.error)
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={cx(styles.panel, { [styles.done]: allUndone })} aria-label={t("changes-label")}>
      <div className={styles.head}>
        <button type="button" className={styles.toggle} onClick={() => setOpen((was) => !was)} aria-expanded={open}>
          <span className={cx("codicon", open ? "codicon-chevron-down" : "codicon-chevron-right")} aria-hidden="true" />
          <span className={styles.title}>{t("changes-files", { count: changes.files.length })}</span>
          <Counts {...totals} />
          {allUndone && <span className={styles.state}>{t("changes-undone")}</span>}
        </button>
        {left.length > 1 && (
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => void undo()}
            title={t("changes-undo-all-title")}
          >
            <span className="codicon codicon-discard" aria-hidden="true" />
            {t("changes-undo-all")}
          </button>
        )}
      </div>
      {open && (
        <ul className={styles.files}>
          {changes.files.map((file) => (
            <li key={file.path} className={cx(styles.file, { [styles.undone]: file.undone })}>
              <button
                type="button"
                className={styles.path}
                title={t("changes-open-title", { path: file.path })}
                onClick={() => emit(EVENT_NAME.pointerOpenChange, { id: changes.id, path: file.path })}
              >
                {file.path}
              </button>
              {file.status !== "modified" && <span className={styles.status}>{t(`changes-${file.status}`)}</span>}
              <Counts added={file.added} removed={file.removed} />
              {file.undone ? (
                <span className={styles.state}>{t("changes-undone")}</span>
              ) : file.noUndo ? (
                <span className={styles.state} title={t("changes-no-undo-title")}>
                  {t("changes-no-undo")}
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.action}
                  disabled={busy}
                  onClick={() => void undo([file.path])}
                  title={t("changes-undo-title", { path: file.path })}
                >
                  {t("changes-undo")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default ReplyChanges
