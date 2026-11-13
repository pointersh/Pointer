import { isAbortError, toInferenceError } from "../inference/errors"

export { isAbortError }

export interface ProviderSummary {
  label: string
  modelName: string
  provider?: string
  apiHostname?: string
  apiPort?: number
  apiProtocol?: string
  apiPath?: string
}

export const providerUrl = (provider: ProviderSummary) => {
  if (!provider.apiHostname) return ""
  const protocol = provider.apiProtocol || "http"
  const port = provider.apiPort ? `:${provider.apiPort}` : ""
  return `${protocol}://${provider.apiHostname}${port}${provider.apiPath || ""}`
}

export const describeProviderError = (
  error: unknown,
  provider: ProviderSummary
): string => {
  const failure = toInferenceError(error)
  const raw = failure.message || "Unknown error"
  const lower = raw.toLowerCase()
  const status = failure.status
  const name = `**${provider.label}**`
  const url = providerUrl(provider)
  const where = url ? ` at \`${url}\`` : ""

  let summary: string

  switch (failure.kind) {
    case "unsupported-capability":
      summary = `${name} cannot do this. Pick a provider that supports it.`
      break
    case "provider-unavailable":
      summary =
        status && status >= 500
          ? `${name} returned a server error (${status}). Check the server logs.`
          : `Could not connect to ${name}${where}. ` +
            "Check that the server is running and that the hostname, port and " +
            "protocol in the provider settings are correct."
      break
    case "authentication":
      summary =
        `${name} rejected the request as unauthorised. ` +
        "Check the API key on the provider."
      break
    case "model-unavailable":
      summary =
        `${name} does not have the model \`${provider.modelName}\`. ` +
        "Check the model name, or pull the model first."
      break
    case "rate-limited":
      summary = `${name} is rate limiting requests. Wait a moment and try again.`
      break
    case "timeout":
      summary = `The request to ${name} timed out. The model may still be loading; try again.`
      break
    case "cancelled":
      summary = `The request to ${name} was cancelled.`
      break
    default:
      if (status === 404 || /not found/.test(lower)) {
        summary = `${name} returned 404${where}. Check the API path on the provider.`
      } else if (/context length|too many tokens|maximum context|token limit/.test(lower)) {
        summary =
          `The prompt was too long for \`${provider.modelName}\`. ` +
          "Start a new conversation or remove some context files."
      } else {
        summary = `${name} returned an error.`
      }
  }

  return `${summary}\n\n\`${raw}\``
}

export const describeProviderErrorPlain = (
  error: unknown,
  provider: ProviderSummary
): string =>
  describeProviderError(error, provider)
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n\n/g, " — ")

export const stripThinking = (text: string): string =>
  text
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^<(think|thinking)>[\s\S]*$/i, "")
    .trim()
