/**
 * Where a configured provider becomes something a feature can call.
 *
 * Adapters register for the provider kinds they serve. `resolve()` picks
 * the adapter for a configuration, builds its provider, and wraps it so
 * that every capability is callable, unsupported ones fail before any
 * request is made, cancellation ends a read at once, and whatever a client
 * throws comes out as an `InferenceError`.
 */
import { OPEN_AI_COMPATIBLE_PROVIDERS } from "../../common/constants"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"

import { HostedInferenceProvider } from "./adapters/hosted"
import { HttpInferenceProvider } from "./adapters/http"
import { InferenceError, toInferenceError, unsupportedCapability } from "./errors"
import { SecretShieldMode, shieldClient, shouldShield } from "./shield"
import { abortable } from "./stream"
import {
  InferenceCapability,
  InferenceClient,
  InferenceOptions,
  InferenceProvider
} from "./types"

/** One way of serving a family of provider kinds. */
export interface InferenceAdapter {
  readonly id: string
  create(config: PointerProvider): InferenceProvider
}

const guardedStream = <T>(
  provider: InferenceProvider,
  run: (() => AsyncIterable<T>) | undefined,
  capability: InferenceCapability,
  options?: InferenceOptions
): AsyncIterable<T> => {
  if (!run || !provider.capabilities().includes(capability)) {
    throw unsupportedCapability(provider.id, capability)
  }
  return (async function* () {
    try {
      yield* abortable(run(), options?.signal)
    } catch (error) {
      throw toInferenceError(error)
    }
  })()
}

const guardedPromise = async <T>(
  provider: InferenceProvider,
  what: InferenceCapability | "models",
  run: (() => Promise<T>) | undefined
): Promise<T> => {
  if (!run || (what !== "models" && !provider.capabilities().includes(what))) {
    throw unsupportedCapability(provider.id, what)
  }
  try {
    return await run()
  } catch (error) {
    throw toInferenceError(error)
  }
}

/** The provider boundary, applied to whatever an adapter built. */
export const guard = (provider: InferenceProvider): InferenceClient => ({
  id: provider.id,
  capabilities: () => provider.capabilities(),
  models: (options) =>
    guardedPromise(provider, "models", provider.models && (() => provider.models!(options))),
  fim: (request, options) =>
    guardedStream(
      provider,
      provider.fim && (() => provider.fim!(request, options)),
      "fim",
      options
    ),
  chat: (request, options) =>
    guardedStream(
      provider,
      provider.chat && (() => provider.chat!(request, options)),
      "chat",
      options
    ),
  embeddings: (request, options) =>
    guardedPromise(
      provider,
      "embeddings",
      provider.embeddings && (() => provider.embeddings!(request, options))
    )
})

export class ProviderRegistry {
  private readonly _adapters = new Map<string, InferenceAdapter>()

  /** Serve these provider kinds with this adapter; a later call replaces. */
  public register(providerIds: string | string[], adapter: InferenceAdapter): this {
    for (const id of Array.isArray(providerIds) ? providerIds : [providerIds]) {
      this._adapters.set(id, adapter)
    }
    return this
  }

  public unregister(providerId: string): this {
    this._adapters.delete(providerId)
    return this
  }

  public get(providerId: string): InferenceAdapter | undefined {
    return this._adapters.get(providerId)
  }

  public has(providerId: string): boolean {
    return this._adapters.has(providerId)
  }

  public providerIds(): string[] {
    return [...this._adapters.keys()]
  }

  /** The client for a configured provider. Throws when nothing serves its kind. */
  public resolve(config: PointerProvider): InferenceClient {
    const adapter = this._adapters.get(config.provider)
    if (!adapter) {
      throw new InferenceError(
        "provider-unavailable",
        `No inference adapter is registered for provider "${config.provider}".`
      )
    }
    return guard(adapter.create(config))
  }
}

export const httpAdapter: InferenceAdapter = {
  id: "http",
  create: (config) => new HttpInferenceProvider(config)
}

export const hostedAdapter: InferenceAdapter = {
  id: "hosted",
  create: (config) => new HostedInferenceProvider(config)
}

/** The registry the extension uses, with every built-in kind served. */
export const providerRegistry = new ProviderRegistry()
  .register(Object.values(OPEN_AI_COMPATIBLE_PROVIDERS), httpAdapter)
  .register(HOSTED_PROVIDERS, hostedAdapter)

/** The `pointer.secretShield` setting, when VS Code is around. */
const secretShieldMode = (): SecretShieldMode => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require("vscode") as typeof import("vscode")
    return vscode.workspace
      .getConfiguration("pointer")
      .get<SecretShieldMode>("secretShield", "offMachine")
  } catch {
    return "offMachine"
  }
}

/**
 * The client a feature calls. Requests that would leave the machine go
 * through the secret shield.
 */
export const resolveInferenceProvider = (config: PointerProvider): InferenceClient => {
  const client = providerRegistry.resolve(config)
  return shouldShield(config, secretShieldMode()) ? shieldClient(client, config) : client
}
