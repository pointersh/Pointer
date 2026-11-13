import React, { useRef, useState } from "react"
import { useTranslation } from "../strings"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import {
  DEFAULT_PROVIDER_FORM_VALUES,
  EVENT_NAME
} from "../../common/constants"
import { ProviderTestResult } from "../../common/messaging/protocol"
import { getEndpointDefaults } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"
import {
  OFFERED_PROVIDER_TYPES,
  ProviderType,
  useProviders
} from "../hooks/useProviders"
import { emit } from "../messaging"

import { PresetGallery } from "./presets"
import { ProviderCard } from "./provider-card"
import { ProviderForm } from "./provider-form"
import { Welcome } from "./welcome"

import styles from "../styles/providers.module.css"

type View =
  | { name: "list" }
  | { name: "gallery"; type: ProviderType }
  | { name: "form"; provider: PointerProvider }

const SECTION_ICONS: Record<ProviderType, string> = {
  chat: "comment-discussion",
  embedding: "database"
}

/** A blank draft for the custom form: any OpenAI-compatible server, on the usual local port. */
const blankProvider = (type: ProviderType): PointerProvider => {
  const defaults = getEndpointDefaults(
    DEFAULT_PROVIDER_FORM_VALUES.provider,
    type
  )
  return {
    ...DEFAULT_PROVIDER_FORM_VALUES,
    ...defaults,
    type
  }
}

interface ProvidersProps {
  /** Called once a chat provider exists where there was none: back to chat. */
  onDone?: () => void
}

export const Providers = ({ onDone }: ProvidersProps) => {
  const { t } = useTranslation()
  const [view, setView] = useState<View>({ name: "list" })
  // Set when the gallery was opened from the welcome, so saving the first
  // chat provider finishes the setup rather than showing the list.
  const fromWelcome = useRef(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({})
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<
    Partial<Record<ProviderType, boolean>>
  >({})
  const {
    activeProviders,
    providers,
    getProvidersByType,
    setActiveProvider,
    removeProvider,
    copyProvider,
    resetProviders,
    testProvider,
    triggerExportProviders,
    triggerImportProviders
  } = useProviders()

  const runTest = async (provider: PointerProvider) => {
    setTesting((current) => new Set(current).add(provider.id))
    setResults((current) => {
      const next = { ...current }
      delete next[provider.id]
      return next
    })
    const result = await testProvider(provider)
    setResults((current) => ({ ...current, [provider.id]: result }))
    setTesting((current) => {
      const next = new Set(current)
      next.delete(provider.id)
      return next
    })
  }

  const openGallery = (type: ProviderType) => setView({ name: "gallery", type })
  const openForm = (provider: PointerProvider) =>
    setView({ name: "form", provider })
  const closeView = () => setView({ name: "list" })

  const finishSetup = () => {
    fromWelcome.current = false
    emit(EVENT_NAME.pointerHideBackButton)
    onDone?.()
  }

  const chooseFromWelcome = (type: ProviderType) => {
    fromWelcome.current = true
    openGallery(type)
  }

  if (view.name === "gallery") {
    return (
      <div className={styles.page}>
        <PresetGallery
          type={view.type}
          onSelect={openForm}
          onCustom={() => openForm(blankProvider(view.type))}
          onBack={closeView}
        />
      </div>
    )
  }

  if (view.name === "form") {
    return (
      <div className={styles.page}>
        <ProviderForm
          initial={view.provider}
          onClose={closeView}
          onSaved={(saved) => {
            // A fresh test result for what was just saved is more useful than
            // a stale one for what it used to be.
            setResults((current) => {
              const next = { ...current }
              delete next[saved.id]
              return next
            })
            if (fromWelcome.current && saved.type === "chat") finishSetup()
          }}
        />
      </div>
    )
  }

  // Nothing configured: the welcome takes the whole tab. The header stays
  // so the toolbar (import, in particular) is still reachable.
  const empty = Object.keys(providers).length === 0

  const renderSection = (type: ProviderType) => {
    const list = getProvidersByType(type).sort((a, b) =>
      a.label.localeCompare(b.label)
    )
    const active = activeProviders[type]
    const open = !collapsed[type]
    return (
      <section key={type} className={styles.section}>
        <div className={styles.sectionHeader}>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={open}
            onClick={() => setCollapsed((c) => ({ ...c, [type]: open }))}
          >
            <i
              className={`codicon codicon-chevron-${open ? "down" : "right"}`}
            />
            <i className={`codicon codicon-${SECTION_ICONS[type]}`} />
            {t(`type-${type}`)}
            <span className={styles.sectionCount}>{list.length}</span>
          </button>
          <VSCodeButton
            appearance="icon"
            title={t(`add-${type}-provider`)}
            aria-label={t(`add-${type}-provider`)}
            onClick={() => openGallery(type)}
          >
            <i className="codicon codicon-add" />
          </VSCodeButton>
        </div>

        {open &&
          (list.length === 0 ? (
            <button
              type="button"
              className={styles.emptySection}
              onClick={() => openGallery(type)}
            >
              <i className="codicon codicon-add" />
              <span className={styles.emptySectionText}>
                <span>{t(`add-${type}-provider`)}</span>
                <span className={styles.emptySectionBlurb}>
                  {t(`type-${type}-blurb`)}
                </span>
              </span>
            </button>
          ) : (
            list.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                active={active?.id === provider.id}
                testResult={results[provider.id]}
                testing={testing.has(provider.id)}
                onActivate={() => setActiveProvider(type, provider)}
                onTest={() => runTest(provider)}
                onEdit={() => openForm(provider)}
                onCopy={() => copyProvider(provider)}
                onDelete={() => removeProvider(provider)}
              />
            ))
          ))}
      </section>
    )
  }

  return (
    <div className={styles.page}>
      <div className="tw-page-header">
        <h3>{t("providers")}</h3>
        <div className={styles.toolbar}>
          <VSCodeButton
            appearance="icon"
            title={t("import-providers")}
            aria-label={t("import-providers")}
            onClick={triggerImportProviders}
          >
            <i className="codicon codicon-cloud-upload" />
          </VSCodeButton>
          <VSCodeButton
            appearance="icon"
            title={t("export-providers")}
            aria-label={t("export-providers")}
            onClick={triggerExportProviders}
          >
            <i className="codicon codicon-cloud-download" />
          </VSCodeButton>
          <VSCodeButton
            appearance="icon"
            title={t("reset-providers")}
            aria-label={t("reset-providers")}
            onClick={() => setConfirmingReset(true)}
          >
            <i className="codicon codicon-discard" />
          </VSCodeButton>
        </div>
      </div>

      {confirmingReset && (
        <div className={styles.confirmBanner}>
          <span>{t("reset-providers-confirm")}</span>
          <VSCodeButton
            appearance="secondary"
            onClick={() => setConfirmingReset(false)}
          >
            {t("cancel")}
          </VSCodeButton>
          <VSCodeButton
            appearance="primary"
            onClick={() => {
              setConfirmingReset(false)
              setResults({})
              resetProviders()
            }}
          >
            {t("reset")}
          </VSCodeButton>
        </div>
      )}

      {empty && (
        <Welcome
          onChoose={chooseFromWelcome}
          onImport={triggerImportProviders}
          onUsed={(created) => {
            if (created.some((p) => p.type === "chat")) finishSetup()
          }}
        />
      )}

      {!empty && OFFERED_PROVIDER_TYPES.map(renderSection)}
    </div>
  )
}
