import * as vscode from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY
} from "../../common/constants"

import { PointerProvider } from "./manager"

export class Base {
  public config = vscode.workspace.getConfiguration("pointer")
  public context?: vscode.ExtensionContext
  private _configListener: vscode.Disposable

  constructor(context: vscode.ExtensionContext) {
    this.context = context

    this._configListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (!event.affectsConfiguration("pointer")) return
        this.updateConfig()
      }
    )
  }

  public dispose() {
    this._configListener.dispose()
  }

  public getFimProvider = () =>
    this.context?.globalState.get<PointerProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )

  public getProvider = () =>
    this.context?.globalState.get<PointerProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )

  public getEmbeddingProvider = () =>
    this.context?.globalState.get<PointerProvider>(
      ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY
    )

  public updateConfig() {
    this.config = vscode.workspace.getConfiguration("pointer")
  }
}
