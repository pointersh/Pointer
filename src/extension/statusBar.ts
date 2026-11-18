import { StatusBarItem } from "vscode"

import { POINTER_COMMAND_NAME } from "../common/constants"

import { GenerationTracker } from "./generations"

export class PointerStatusBar {
  private readonly _subscription: { dispose(): void }

  constructor(
    private readonly _item: StatusBarItem,
    private readonly _generations: GenerationTracker
  ) {
    this._item.name = "Pointer"
    this._subscription = _generations.onDidChange(() => this.refresh())
  }

  public refresh() {
    if (this._generations.state.busy) {
      this._item.text = "$(loading~spin)"
      this._item.tooltip = "Pointer is working. Click to stop."
      this._item.command = POINTER_COMMAND_NAME.stopGeneration
    } else {
      this._item.text = "$(code)"
      this._item.tooltip = "Pointer: open the panel"
      this._item.command = POINTER_COMMAND_NAME.focusSidebar
    }
    this._item.show()
  }

  public dispose() {
    this._subscription.dispose()
    this._item.dispose()
  }
}
