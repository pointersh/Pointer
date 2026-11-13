import { ExtensionContext, StatusBarItem, workspace } from "vscode"

import {
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  POINTER_COMMAND_NAME
} from "../common/constants"
import { PointerProvider } from "../common/types"

import { GenerationTracker } from "./generations"

const ICON_IDLE = "$(code)"
const ICON_BUSY = "$(loading~spin)"

export class PointerStatusBar {
  private readonly _subscription: { dispose(): void }

  constructor(
    private readonly _item: StatusBarItem,
    private readonly _context: ExtensionContext,
    private readonly _generations: GenerationTracker
  ) {
    this._item.name = "Pointer"
    this._subscription = _generations.onDidChange((state) => {
      if (state.busy) this.showBusy()
      else this.refresh()
    })
  }

  private showBusy() {
    this._item.text = ICON_BUSY
    this._item.tooltip = "Pointer is generating — click to stop"
    this._item.command = POINTER_COMMAND_NAME.stopGeneration
    this._item.show()
  }

  public refresh() {
    if (this._generations.state.busy) return

    const config = workspace.getConfiguration("pointer")
    if (!config.get<boolean>("enabled", true)) {
      this._item.hide()
      return
    }

    const autoSuggest = config.get<boolean>("autoSuggestEnabled", true)
    const provider = this._context.globalState.get<PointerProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )

    const lines = [
      provider
        ? `Pointer · ${provider.modelName} (${provider.label})`
        : "Pointer · no FIM provider selected",
      autoSuggest
        ? "Auto-suggest is on"
        : "Auto-suggest is off — trigger completions manually with Alt+\\",
      "Click for options"
    ]

    this._item.text = autoSuggest ? ICON_IDLE : `${ICON_IDLE} off`
    this._item.tooltip = lines.join("\n")
    this._item.command = POINTER_COMMAND_NAME.statusBarMenu
    this._item.show()
  }

  public dispose() {
    this._subscription.dispose()
    this._item.dispose()
  }
}
