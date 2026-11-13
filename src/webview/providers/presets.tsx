import React, { ReactNode, useState } from "react"
import { useTranslation } from "../strings"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import {
  API_PROVIDERS,
  PROVIDER_DISPLAY_NAMES
} from "../../common/constants"
import { getEndpointDefaults } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"
import { ProviderType } from "../hooks/useProviders"
import {
  SvgAnthropic,
  SvgCohere,
  SvgDeepseek,
  SvgGemini,
  SvgGroq,
  SvgMistral,
  SvgOllama,
  SvgOpenAI,
  SvgOpenRouter,
  SvgPerplexity
} from "../icons"

import styles from "../styles/providers.module.css"

export interface ProviderPreset {
  key: string
  label: string
  /** i18n key for the one-line blurb under the name. */
  descriptionKey: string
  logo: ReactNode
  provider: string
  type: ProviderType
  modelName: string
  /** Local servers are listed first: they are what pointer is built around. */
  local: boolean
}

const codicon = (name: string) => <i className={`codicon codicon-${name}`} />

const LOCAL_LOGOS: Record<string, ReactNode> = {
  [API_PROVIDERS.Ollama]: <SvgOllama />,
  [API_PROVIDERS.LMStudio]: codicon("vm"),
  [API_PROVIDERS.LlamaCpp]: codicon("terminal"),
  [API_PROVIDERS.OpenWebUI]: codicon("browser"),
  [API_PROVIDERS.LiteLLM]: codicon("server-environment"),
  [API_PROVIDERS.Oobabooga]: codicon("server"),
  [API_PROVIDERS.OpenAICompatible]: codicon("plug")
}

const local = (
  provider: string,
  type: ProviderType,
  modelName = ""
): ProviderPreset => ({
  key: `${provider}-${type}`,
  label: PROVIDER_DISPLAY_NAMES[provider],
  descriptionKey: `preset-${provider}`,
  logo: LOCAL_LOGOS[provider],
  provider,
  type,
  modelName,
  local: true
})

const hosted = (
  provider: string,
  label: string,
  logo: ReactNode,
  modelName: string,
  type: ProviderType = "chat"
): ProviderPreset => ({
  key: `${provider}-${type}`,
  label,
  descriptionKey: `preset-${provider}`,
  logo,
  provider,
  type,
  modelName,
  local: false
})

/**
 * Model names are left blank for local servers on purpose: the form asks the
 * server what it has and picks the first match, which is always more useful
 * than a hard-coded name that may not be pulled.
 */
export const PRESETS: ProviderPreset[] = [
  // chat
  local(API_PROVIDERS.Ollama, "chat"),
  local(API_PROVIDERS.LMStudio, "chat"),
  local(API_PROVIDERS.LlamaCpp, "chat"),
  local(API_PROVIDERS.OpenAICompatible, "chat"),
  local(API_PROVIDERS.OpenWebUI, "chat"),
  local(API_PROVIDERS.LiteLLM, "chat"),
  local(API_PROVIDERS.Oobabooga, "chat"),
  hosted(API_PROVIDERS.OpenAI, "OpenAI", <SvgOpenAI />, "gpt-4.1"),
  hosted(
    API_PROVIDERS.Anthropic,
    "Anthropic",
    <SvgAnthropic />,
    "claude-sonnet-5-5"
  ),
  hosted(API_PROVIDERS.Deepseek, "DeepSeek", <SvgDeepseek />, "deepseek-flash"),
  hosted(API_PROVIDERS.Gemini, "Gemini", <SvgGemini />, "gemini-3.8-flash"),
  hosted(API_PROVIDERS.Groq, "Groq", <SvgGroq />, "llama-3.3-70b-versatile"),
  hosted(API_PROVIDERS.Mistral, "Mistral", <SvgMistral />, "mistral-small-latest"),
  hosted(API_PROVIDERS.OpenRouter, "OpenRouter", <SvgOpenRouter />, "openai/gpt-4.1"),
  hosted(
    API_PROVIDERS.DemonRoute,
    "DemonRoute",
    codicon("plug"),
    "shoukewei/Qwen3.8-27B-OBLITERATED22-AGENT",
    "chat"
  ),
  hosted(API_PROVIDERS.Cohere, "Cohere", <SvgCohere />, "command-a-plus-05-2026"),
  hosted(
    API_PROVIDERS.Perplexity,
    "Perplexity",
    <SvgPerplexity />,
    "sonar"
  ),
  // embedding
  local(API_PROVIDERS.Ollama, "embedding"),
  local(API_PROVIDERS.LMStudio, "embedding"),
  local(API_PROVIDERS.LlamaCpp, "embedding"),
  local(API_PROVIDERS.OpenAICompatible, "embedding"),
  hosted(
    API_PROVIDERS.OpenAI,
    "OpenAI",
    <SvgOpenAI />,
    "text-embedding-3-small",
    "embedding"
  )
]

/** Turns a preset into the draft the form opens with. */
export const presetToProvider = (preset: ProviderPreset): PointerProvider => {
  const endpoint = getEndpointDefaults(preset.provider, preset.type)
  const suffix = preset.type === "chat" ? "" : ` ${preset.type.toUpperCase()}`
  return {
    id: "",
    label: `${preset.label}${suffix}`,
    modelName: preset.modelName,
    provider: preset.provider,
    type: preset.type,
    apiHostname: endpoint?.apiHostname ?? "",
    apiPort: endpoint?.apiPort,
    apiProtocol: endpoint?.apiProtocol ?? "http",
    apiPath: endpoint?.apiPath ?? "",
    apiKey: ""
  }
}

interface PresetGalleryProps {
  type: ProviderType
  onSelect: (provider: PointerProvider) => void
  onCustom: () => void
  onBack: () => void
}

export const PresetGallery = ({
  type,
  onSelect,
  onCustom,
  onBack
}: PresetGalleryProps) => {
  const { t } = useTranslation()
  const [showAll, setShowAll] = useState(false)
  const presets = PRESETS.filter((preset) => preset.type === type)
  const localPresets = presets.filter((preset) => preset.local)
  const hostedPresets = presets.filter((preset) => !preset.local)

  const renderPreset = (preset: ProviderPreset) => (
    <button
      key={preset.key}
      type="button"
      className={styles.presetCard}
      onClick={() => onSelect(presetToProvider(preset))}
    >
      <span className={styles.presetLogo}>{preset.logo}</span>
      <span className={styles.presetBody}>
        <span className={styles.presetName}>{preset.label}</span>
        <span className={styles.presetDescription}>
          {t(preset.descriptionKey)}
        </span>
      </span>
      <i className={`codicon codicon-chevron-right ${styles.presetChevron}`} />
    </button>
  )

  return (
    <div className={styles.gallery}>
      <div className={styles.viewHeader}>
        <VSCodeButton appearance="icon" onClick={onBack} title={t("back")}>
          <i className="codicon codicon-arrow-left" />
        </VSCodeButton>
        <h4>{t(`add-${type}-provider`)}</h4>
      </div>

      <p className={styles.galleryIntro}>{t(`preset-intro-${type}`)}</p>

      <h5 className={styles.galleryGroup}>{t("preset-group-local")}</h5>
      <div className={styles.presetList}>
        {(showAll ? localPresets : localPresets.slice(0, 4)).map(renderPreset)}
      </div>
      {localPresets.length > 4 && !showAll && (
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => setShowAll(true)}
        >
          {t("preset-show-more", { count: localPresets.length - 4 })}
        </button>
      )}

      {hostedPresets.length > 0 && (
        <>
          <h5 className={styles.galleryGroup}>{t("preset-group-hosted")}</h5>
          <div className={styles.presetList}>{hostedPresets.map(renderPreset)}</div>
        </>
      )}

      <div className={styles.galleryFooter}>
        <VSCodeButton appearance="secondary" onClick={onCustom}>
          <i className="codicon codicon-settings-gear" />
          {t("custom-provider")}
        </VSCodeButton>
      </div>
    </div>
  )
}
