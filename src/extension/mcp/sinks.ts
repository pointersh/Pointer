import { ApproveChange, editorEdits, editorKnowledge, terminalCommands } from "../chat/tool-sinks"
import { WorkspaceView } from "../tools/view"
import { ToolExtras } from "../tools/workspace"

export const editorExtras = (root: string, approve: ApproveChange): { view: WorkspaceView; extras: ToolExtras } => {
  const view = new WorkspaceView(root)
  return {
    view,
    extras: {
      edits: editorEdits(view, "review", approve),
      editor: editorKnowledge(view, "review", approve),
      commands: terminalCommands(() => "ask", root, (command) => approve(command, "command"))
    }
  }
}
