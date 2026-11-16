import { editorEdits, editorKnowledge, terminalCommands } from "../chat/tool-sinks"
import { WorkspaceView } from "../tools/view"
import { ToolExtras } from "../tools/workspace"

export const editorExtras = (root: string): { view: WorkspaceView; extras: ToolExtras } => {
  const view = new WorkspaceView(root)
  return {
    view,
    extras: { edits: editorEdits(view), editor: editorKnowledge(view), commands: terminalCommands(root) }
  }
}
