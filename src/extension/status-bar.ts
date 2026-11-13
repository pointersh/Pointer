import { ExtensionContext, StatusBarItem } from "vscode"

import { ACTIVE_CHAT_PROVIDER_STORAGE_KEY, POINTER_COMMAND_NAME } from "../common/constants"
import { PointerProvider } from "../common/types"

import { GenerationTracker } from "./generations"

export class PointerStatusBar {
  private readonly _subscription: { dispose(): void }

  constructor(
    private readonly _item: StatusBarItem,
    private readonly _context: ExtensionContext,
    private readonly _generations: GenerationTracker
  ) {
    this._item.name = "Pointer"
    this._subscription = _generations.onDidChange(() => this.refresh())
  }

  public refresh() {
    if (this._generations.state.busy) {
      this._item.text = "$(loading~spin)"
      this._item.tooltip = "Pointer is generating — click to stop"
      this._item.command = POINTER_COMMAND_NAME.stopGeneration
    } else {
      const provider = this._context.globalState.get<PointerProvider>(ACTIVE_CHAT_PROVIDER_STORAGE_KEY)
      this._item.text = "$(code)"
      this._item.tooltip = provider ? `Pointer · ${provider.modelName} (${provider.label})` : "Pointer · no model selected"
      this._item.command = POINTER_COMMAND_NAME.openChat
    }
    this._item.show()
  }

  public dispose() {
    this._subscription.dispose()
    this._item.dispose()
  }
}
