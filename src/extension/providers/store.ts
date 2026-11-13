import { TextDecoder, TextEncoder } from "util"
import { ExtensionContext, Uri, window, workspace } from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  GLOBAL_STORAGE_KEY,
  INFERENCE_PROVIDERS_STORAGE_KEY,
  POINTER_PROVIDERS_FILENAME
} from "../../common/constants"
import { messageOf } from "../../common/errors"
import { PROVIDER_TYPES, ProviderType } from "../../common/provider-validation"
import { PointerProvider } from "../../common/types"

export type Providers = Record<string, PointerProvider>

const ACTIVE_KEYS: Record<ProviderType, string> = {
  chat: ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  embedding: ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
}

export class ProviderStore {
  private readonly _location: string

  constructor(private readonly _context: ExtensionContext) {
    this._location =
      workspace.getConfiguration("pointer").get("providerStorageLocation") ||
      "globalState"
  }


  public async getProviders(): Promise<Providers> {
    const providers =
      this._location === "file"
        ? await this._readFile()
        : this._context.globalState.get<Providers>(INFERENCE_PROVIDERS_STORAGE_KEY)
    return providers && typeof providers === "object" ? providers : {}
  }

  public async saveProviders(providers: Providers): Promise<void> {
    if (this._location === "file") {
      await this._writeFile(providers)
    } else {
      await this._context.globalState.update(
        INFERENCE_PROVIDERS_STORAGE_KEY,
        providers
      )
    }
  }

  public async hasProviders(): Promise<boolean> {
    return Object.keys(await this.getProviders()).length > 0
  }

  public async migrateLegacy(): Promise<boolean> {
    if (this._location !== "file") return false
    if (await this.hasProviders()) return false
    const legacy = this._context.globalState.get<Providers>(
      INFERENCE_PROVIDERS_STORAGE_KEY
    )
    if (!legacy || Object.keys(legacy).length === 0) return false
    await this.saveProviders(legacy)
    return true
  }


  public getActive(type: ProviderType): PointerProvider | undefined {
    return this._context.globalState.get<PointerProvider>(ACTIVE_KEYS[type])
  }

  public async setActive(type: ProviderType, provider?: PointerProvider) {
    await this._context.globalState.update(ACTIVE_KEYS[type], provider)
    if (type === "chat") {
      await this._context.globalState.update(
        `${EVENT_NAME.pointerGlobalContext}-${GLOBAL_STORAGE_KEY.selectedModel}`,
        provider?.modelName
      )
    }
  }

  public async addAll(providers: PointerProvider[]): Promise<ProviderType[]> {
    const all = await this.getProviders()
    const activated: ProviderType[] = []
    for (const provider of providers) all[provider.id] = provider
    await this.saveProviders(all)
    for (const provider of providers) {
      const type = asType(provider.type)
      if (this.getActive(type)) continue
      await this.setActive(type, provider)
      activated.push(type)
    }
    return activated
  }

  public async repairActive(): Promise<void> {
    const providers = Object.values(await this.getProviders())
    for (const type of PROVIDER_TYPES) {
      const active = this.getActive(type)
      if (active && providers.some((p) => p.id === active.id)) continue
      const replacement = providers.find((p) => p.type === type)
      if (replacement || active) await this.setActive(type, replacement)
    }
  }


  private _fileUri() {
    return Uri.joinPath(this._context.globalStorageUri, POINTER_PROVIDERS_FILENAME)
  }

  private async _readFile(): Promise<Providers | undefined> {
    try {
      const content = await workspace.fs.readFile(this._fileUri())
      return JSON.parse(new TextDecoder().decode(content)) as Providers
    } catch {
      return undefined
    }
  }

  private async _writeFile(providers: Providers): Promise<void> {
    try {
      await workspace.fs.createDirectory(this._context.globalStorageUri)
      const content = JSON.stringify(providers, null, 2)
      await workspace.fs.writeFile(
        this._fileUri(),
        new TextEncoder().encode(content)
      )
    } catch (e) {
      console.error(e)
      window.showErrorMessage(
        `pointer could not write ${POINTER_PROVIDERS_FILENAME}: ${
          messageOf(e)
        }`
      )
      throw e
    }
  }
}

export const asType = (type: string): ProviderType =>
  type === "embedding" ? type : "chat"
