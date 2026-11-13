import * as vscode from "vscode"

import { POINTER_COMMAND_NAME } from "../../common/constants"

import { InlineEditArgs } from "./service"

const FIXABLE = new Set([
  vscode.DiagnosticSeverity.Error,
  vscode.DiagnosticSeverity.Warning
])

const MAX_FIX_LINES = 60

export class InlineEditCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite
  ]

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = []
    const seen = new Set<string>()

    for (const diagnostic of context.diagnostics) {
      if (!FIXABLE.has(diagnostic.severity)) continue
      const message = diagnostic.message.trim().replace(/\s+/g, " ")
      const key = `${diagnostic.range.start.line}:${message}`
      if (seen.has(key)) continue
      seen.add(key)

      const action = new vscode.CodeAction(
        `Fix with Pointer: ${shorten(message, 60)}`,
        vscode.CodeActionKind.QuickFix
      )
      action.diagnostics = [diagnostic]
      action.command = this.command("Fix with Pointer", {
        uri: document.uri,
        range: this.fixRange(document, diagnostic.range),
        instruction: fixInstruction(diagnostic)
      })
      actions.push(action)
    }

    if (!range.isEmpty) {
      const action = new vscode.CodeAction(
        "Edit with Pointer…",
        vscode.CodeActionKind.RefactorRewrite
      )
      action.command = this.command("Edit with Pointer", {
        uri: document.uri,
        range
      })
      actions.push(action)
    }

    return actions
  }

  private command(title: string, args: InlineEditArgs): vscode.Command {
    return { title, command: POINTER_COMMAND_NAME.edit, arguments: [args] }
  }

  private fixRange(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.Range {
    const endLine = Math.min(range.end.line, range.start.line + MAX_FIX_LINES - 1)
    return new vscode.Range(
      range.start.line,
      0,
      endLine,
      document.lineAt(endLine).range.end.character
    )
  }
}

const shorten = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const fixInstruction = (diagnostic: vscode.Diagnostic): string => {
  const source = diagnostic.source ? ` (${diagnostic.source})` : ""
  return `Fix this problem${source}: ${diagnostic.message.trim()}`
}
