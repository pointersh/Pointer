import * as fs from "fs"
import * as vscode from "vscode"

import { EXTENSION_CONTEXT_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import { ChatCompletionMessage } from "../../common/types"
import { cancelled } from "../chat/tickets"
import { GenerationRun, GenerationTracker } from "../generations"
import { TextModel, textModel } from "../model"

import { DiffLayout, layoutDiff, locateSnippet } from "./diff"
import {
  buildEditMessages,
  clampContext,
  EDIT_CONTEXT_LINES,
  finalizeEdit,
  matchIndentation,
  previewEdit
} from "./prompt"
import {
  diffLineDecoration,
  DiffRegion,
  diffWordDecoration,
  lineRange,
  spanRange
} from "./region"

export interface InlineEditArgs {
  uri?: vscode.Uri | string
  range?: vscode.Range
  instruction?: string
  requireSelection?: boolean
}

export type { Hunk } from "./region"

export interface ChatEditOutcome {
  ok: boolean
  message: string
  pending?: boolean
}

export interface FileEditProposal {
  file: string
  startLine: number
  endLine: number
  original: string
  text: string
  ticket?: string
}

const outsideWorkspace = (uri: vscode.Uri) =>
  !!vscode.workspace.workspaceFolders?.length && !vscode.workspace.getWorkspaceFolder(uri)

interface PendingEditInfo {
  line: number
  streaming: boolean
  hunks: number[]
}

interface Generation {
  region: DiffRegion
  messages: ChatCompletionMessage[]
  preview: (reply: string) => string
  finalize: (reply: string) => string
  what: string
  describe: string
}

// Under TrueForge's 120 s MCP request timeout (MCP_REQUEST_TIMEOUT_MS) and Pointer's 150 s stall watchdog.
const SLOT_WAIT_MS = 100_000

const mac = process.platform === "darwin"
const REVIEW_HINT = mac
  ? "Pointer: review the edit — ⌘⇧↩ accepts, ⌘⇧⌫ rejects"
  : "Pointer: review the edit — Ctrl+Shift+Enter accepts, Ctrl+Shift+Backspace rejects"

export class InlineEditService {
  private _run?: GenerationRun
  private _pending?: DiffRegion
  // Set from the first check until _pending is assigned, so two proposals can't both pass the check across an await.
  private _claimed = false
  // Files the agent proposed edits to: saved before the agent runs a command, so tests see accepted changes.
  private _agentDocs = new Set<vscode.TextDocument>()
  // Bumped whenever no generation is live (Stop, New chat, a finished reply): queued proposals give up.
  private _epoch = 0
  private readonly _emitter = new vscode.EventEmitter<void>()
  public readonly onDidChangePending = this._emitter.event

  private readonly _removedDecoration = diffLineDecoration("-")
  private readonly _addedDecoration = diffLineDecoration("+")
  private readonly _removedWords = diffWordDecoration("-")
  private readonly _addedWords = diffWordDecoration("+")

  constructor(
    context: vscode.ExtensionContext,
    private readonly _generations: GenerationTracker
  ) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.onChange(event)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this._agentDocs.delete(document)
        if (this._pending?.document === document) this.clearPending()
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      this._generations.onDidChange(({ busy }) => {
        if (busy) return
        this._epoch++
        this._emitter.fire()
      }),
      vscode.workspace.onWillSaveTextDocument((event) => {
        const pending = this._pending
        if (pending?.document !== event.document) return
        event.waitUntil(Promise.resolve(pending.rejectEdits()))
        if (!this.running) this.clearPending()
        vscode.window.showWarningMessage("Pointer discarded the unreviewed edit so the save writes only your code. Run the edit again to review it.")
      })
    )
  }

  public get running() {
    return this._run !== undefined
  }

  private get busy() {
    return this.running || !!this._pending || this._claimed
  }

  // The agent often proposes edits to several files in one parallel step. They queue: each opens for review
  // once the previous one is accepted or rejected. The slot is claimed in the same tick it is found free, so
  // two waiting proposals can't both take it.
  private async claimSlot(ticket?: string): Promise<"ok" | "timeout" | "stopped"> {
    const until = Date.now() + SLOT_WAIT_MS
    const epoch = this._epoch
    while (this.busy) {
      if (cancelled(ticket) || this._epoch !== epoch) return "stopped"
      if (Date.now() > until) return "timeout"
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 1000)
        const sub = this.onDidChangePending(done)
        function done() {
          clearTimeout(timer)
          sub.dispose()
          resolve()
        }
      })
    }
    if (cancelled(ticket)) return "stopped"
    this._claimed = true
    return "ok"
  }

  public dispose() {
    this._emitter.dispose()
    this._removedDecoration.dispose()
    this._addedDecoration.dispose()
    this._removedWords.dispose()
    this._addedWords.dispose()
  }

  public pendingFor(document: vscode.TextDocument): PendingEditInfo | undefined {
    const pending = this._pending
    if (!pending || pending.document !== document) return undefined
    return {
      line: pending.range.start.line,
      streaming: this.running,
      hunks: pending.hunks.map((hunk) => hunk.line)
    }
  }

  public async run(args?: InlineEditArgs) {
    if (this.running) {
      vscode.window.showInformationMessage(
        "Pointer is already editing; stop it first (Ctrl+Shift+/)."
      )
      return
    }
    const model = this.requireModel()
    if (!model) return

    const pending = this._pending
    if (pending) {
      const editor = await this.editorFor(pending.document)
      const instruction =
        args?.instruction?.trim() ||
        (await this.askInstruction(editor, pending.range, true))
      if (!instruction || this.running || this._pending !== pending) return
      await this.edit(editor, pending, instruction, model)
      return
    }

    const editor = await this.resolveEditor(args?.uri)
    if (!editor) {
      vscode.window.showInformationMessage("Open a file to edit with Pointer.")
      return
    }

    if (args?.requireSelection && !args.range && editor.selection.isEmpty) {
      vscode.window.showInformationMessage("Select the code to edit first.")
      return
    }

    const range = this.wholeLines(editor.document, args?.range ?? editor.selection)
    const instruction =
      args?.instruction?.trim() || (await this.askInstruction(editor, range))
    if (!instruction) return
    if (this.busy) {
      vscode.window.showInformationMessage("Pointer has an edit in progress. Accept or reject it first.")
      return
    }

    await this.edit(editor, new DiffRegion(editor, range), instruction, model)
  }

  public async propose(code: string) {
    if (this.busy) {
      vscode.window.showInformationMessage(
        "Pointer has an edit in progress. Accept or reject it first."
      )
      return
    }
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.window.showInformationMessage("Open a file to apply the code to.")
      return
    }
    const document = editor.document
    const snippet = code.replace(/\s+$/, "")
    if (!snippet.trim()) return

    let range: vscode.Range
    let text: string
    let how: string
    if (!editor.selection.isEmpty) {
      range = this.wholeLines(document, editor.selection)
      text = matchIndentation(snippet, document.getText(range))
      how = "over the selection"
    } else {
      const found = locateSnippet(
        document.getText().split("\n"),
        snippet.split("\n")
      )
      if (found) {
        range = new vscode.Range(
          found.start,
          0,
          found.end,
          document.lineAt(found.end).range.end.character
        )
        text = matchIndentation(snippet, document.getText(range))
        how = `over lines ${found.start + 1}-${found.end + 1}`
      } else {
        const line = editor.selection.active.line
        range = new vscode.Range(line, 0, line, 0)
        text = snippet + "\n"
        how = `at line ${line + 1}`
      }
    }

    const region = new DiffRegion(editor, range)
    const layout = layoutDiff(document.getText(range), text)
    if (!layout.removed.length && !layout.added.length) {
      vscode.window.setStatusBarMessage("Pointer: the file already has that code", 4000)
      return
    }
    this._pending = region
    await region.render(layout)
    editor.revealRange(region.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.present()
    logger.info(`Applied chat code ${how} in ${vscode.workspace.asRelativePath(document.uri)}`)
  }

  public async chatEdit(proposal: FileEditProposal): Promise<ChatEditOutcome> {
    const pending = this._pending
    const uri = vscode.Uri.file(proposal.file)
    const relative = vscode.workspace.asRelativePath(uri)
    if (outsideWorkspace(uri)) {
      return { ok: false, message: `Not changed: ${relative} is outside the workspace.` }
    }
    const slot = await this.claimSlot(proposal.ticket)
    if (slot === "stopped") return { ok: false, message: "Not changed: the request was stopped." }
    if (slot === "timeout") {
      const where = pending ? ` in ${vscode.workspace.asRelativePath(pending.document.uri)}` : ""
      return {
        ok: false,
        message: `Not changed: an edit${where} has been waiting for the user's review for ${SLOT_WAIT_MS / 1000} s. Tell the user to accept or reject it, then ask again.`
      }
    }
    try {
      return await this.proposeEdit(proposal, uri, relative)
    } finally {
      this._claimed = false
    }
  }

  private async proposeEdit(proposal: FileEditProposal, uri: vscode.Uri, relative: string): Promise<ChatEditOutcome> {
    const document = await vscode.workspace.openTextDocument(uri)
    const last = document.lineAt(Math.min(proposal.endLine, document.lineCount - 1))
    const range = new vscode.Range(proposal.startLine, 0, proposal.endLine, last.range.end.character)
    const current = document.getText(range).replace(/\r\n/g, "\n")
    if (proposal.endLine >= document.lineCount || current !== proposal.original) {
      return {
        ok: false,
        message: "Not changed: the file changed while you were working. Read it again and retry."
      }
    }
    const lines =
      proposal.startLine === proposal.endLine
        ? `line ${proposal.startLine + 1}`
        : `lines ${proposal.startLine + 1}-${proposal.endLine + 1}`

    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })
    const region = new DiffRegion(editor, range)
    this._pending = region
    if (!(await region.render(layoutDiff(current, proposal.text)))) {
      this.clearPending()
      return { ok: false, message: `Not changed: the editor refused the edit to ${relative} (is it read-only?).` }
    }
    editor.revealRange(region.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.present()
    this._agentDocs.add(document)
    logger.info(`Chat proposed an edit to ${relative}:${proposal.startLine + 1}`)
    return {
      ok: true,
      pending: true,
      message:
        `Proposed: the change to ${relative} ${lines} is shown in the editor for the user to accept or reject. ` +
        "It is not applied yet; once accepted, it is saved before any command you run. Tell the user in a sentence what you changed."
    }
  }

  public async chatCreate(file: string, content: string, ticket?: string): Promise<ChatEditOutcome> {
    const target = vscode.Uri.file(file)
    const relative = vscode.workspace.asRelativePath(target)
    if (outsideWorkspace(target)) {
      return { ok: false, message: `Not created: ${relative} is outside the workspace.` }
    }
    if (fs.existsSync(file)) {
      return { ok: false, message: `Not created: ${relative} already exists. Use edit_file to change it.` }
    }
    const slot = await this.claimSlot(ticket)
    if (slot === "stopped") return { ok: false, message: "Not created: the request was stopped." }
    if (slot === "timeout") {
      return {
        ok: false,
        message: `Not created: an edit has been waiting for the user's review for ${SLOT_WAIT_MS / 1000} s. Tell the user to accept or reject it, then ask again.`
      }
    }
    try {
      const document = await vscode.workspace.openTextDocument(target.with({ scheme: "untitled" }))
      if (document.getText()) {
        return { ok: false, message: `Not created: an unsaved ${relative} is already open in the editor. Ask the user to save or close it.` }
      }
      this._agentDocs.add(document)
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })
      const region = new DiffRegion(editor, new vscode.Range(0, 0, 0, 0))
      this._pending = region
      if (!(await region.render(layoutDiff("", content.endsWith("\n") ? content : `${content}\n`)))) {
        this.clearPending()
        return { ok: false, message: `Not created: the editor refused to show ${relative}.` }
      }
    } finally {
      this._claimed = false
    }
    this.present()
    logger.info(`Chat proposed a new file ${relative}`)
    return {
      ok: true,
      pending: true,
      message:
        `Proposed: ${relative} is open, unsaved, for the user to accept and save or reject. ` +
        "It does not exist on disk yet. Tell the user in a sentence what the file is for."
    }
  }

  // Accepted agent edits live in the editor until saved; a command the agent runs (tests) reads the disk.
  // A file still under review is skipped: saving it would discard the review. Untitled (created) files are
  // skipped too, since saving one asks where to put it.
  public async saveAgentEdits() {
    for (const document of [...this._agentDocs]) {
      if (document.isClosed) this._agentDocs.delete(document)
      else if (document !== this._pending?.document && document.isDirty) {
        // A new file is an untitled buffer bound to its path; give its save a deadline in case VS Code asks where.
        await Promise.race([document.save(), new Promise((resolve) => setTimeout(resolve, 3_000))])
      }
    }
  }

  // A new conversation starts clean: earlier agent edits are no longer saved for it.
  public forgetAgentEdits() {
    this._agentDocs.clear()
  }

  public accept(hunk?: number) {
    return this.resolve("accept", hunk)
  }

  public reject(hunk?: number) {
    return this.resolve("reject", hunk)
  }

  private async resolve(verdict: "accept" | "reject", hunk?: number) {
    const pending = this._pending
    if (!pending || this.running) return
    const ok = await pending.settle(verdict, hunk)
    if (!ok) {
      this.clearPending()
      vscode.window.showWarningMessage(
        "Pointer could not tidy up the edit; use Undo (Ctrl+Z) to revert it."
      )
      return
    }
    const what = pending.done ? "edit" : "hunk"
    if (pending.done) {
      this.clearPending()
      if (verdict === "reject") await this.closeIfEmptyUntitled(pending.document)
    } else {
      this.decorate()
      this._emitter.fire()
    }
    vscode.window.setStatusBarMessage(
      `Pointer: ${what} ${verdict === "accept" ? "accepted" : "rejected"}`,
      3000
    )
  }

  private requireModel(): TextModel | undefined {
    const model = textModel()
    if (!model) vscode.window.showWarningMessage("Pointer is not connected to TrueForge yet.")
    return model
  }

  private async editorFor(document: vscode.TextDocument) {
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document === document
    )
    return visible ?? vscode.window.showTextDocument(document)
  }

  // On deactivate or reload: put the original text back so no unreviewed diff survives in the buffer.
  public async discard() {
    if (!this._pending) return
    this._run?.abort()
    await this._pending.settle("reject")
    this.clearPending()
  }

  private async closeIfEmptyUntitled(document: vscode.TextDocument) {
    if (!document.isUntitled || document.getText().trim()) return
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document === document
    )
    if (!editor) return
    await vscode.window.showTextDocument(document, editor.viewColumn)
    await vscode.commands.executeCommand(
      "workbench.action.revertAndCloseActiveEditor"
    )
  }

  private async resolveEditor(
    uri?: vscode.Uri | string
  ): Promise<vscode.TextEditor | undefined> {
    const active = vscode.window.activeTextEditor
    if (!uri) return active
    const target = typeof uri === "string" ? vscode.Uri.parse(uri) : uri
    if (active && active.document.uri.toString() === target.toString()) {
      return active
    }
    const document = await vscode.workspace.openTextDocument(target)
    return vscode.window.showTextDocument(document)
  }

  private wholeLines(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.Range {
    let endLine = range.end.line
    if (endLine > range.start.line && range.end.character === 0) endLine--
    return new vscode.Range(
      range.start.line,
      0,
      endLine,
      document.lineAt(endLine).range.end.character
    )
  }

  private async askInstruction(
    editor: vscode.TextEditor,
    range: vscode.Range,
    refine = false
  ): Promise<string | undefined> {
    const lines = range.end.line - range.start.line + 1
    const what =
      lines === 1
        ? `line ${range.start.line + 1}`
        : `lines ${range.start.line + 1}-${range.end.line + 1}`
    const file = vscode.workspace.asRelativePath(editor.document.uri)
    const value = await vscode.window.showInputBox(
      refine
        ? {
            title: `Pointer: refine the edit in ${file}`,
            prompt:
              "Describe how to change the proposed code. Enter to preview, Escape to keep it as is.",
            placeHolder: "e.g. shorter, keep the original names, add a comment",
            ignoreFocusOut: true
          }
        : {
            title: `Pointer: edit ${what} of ${file}`,
            prompt: "Describe the change. Enter to preview it, Escape to cancel.",
            placeHolder:
              "e.g. add error handling, convert to async/await, rename x to count",
            ignoreFocusOut: true
          }
    )
    return value?.trim() || undefined
  }

  private async edit(
    editor: vscode.TextEditor,
    region: DiffRegion,
    instruction: string,
    model: TextModel
  ) {
    const document = editor.document
    const range = region.range
    const { proposed } = region.sides()
    const messages = buildEditMessages({
      instruction,
      code: proposed,
      language: document.languageId,
      fileName: vscode.workspace.asRelativePath(document.uri),
      before: clampContext(
        document.getText(
          new vscode.Range(
            Math.max(0, range.start.line - EDIT_CONTEXT_LINES),
            0,
            range.start.line,
            0
          )
        ),
        true
      ),
      after: clampContext(
        document.getText(
          new vscode.Range(
            range.end.line + 1,
            0,
            Math.min(document.lineCount, range.end.line + 1 + EDIT_CONTEXT_LINES),
            0
          )
        ),
        false
      )
    })

    await this.generate(model, {
      region,
      messages,
      preview: (reply) => previewEdit(reply, proposed),
      finalize: (reply) => finalizeEdit(reply, proposed),
      what: "edit",
      describe: JSON.stringify({
        file: vscode.workspace.asRelativePath(document.uri),
        lines: `${range.start.line + 1}-${range.end.line + 1}`,
        instruction
      })
    })
  }

  private async generate(model: TextModel, generation: Generation) {
    const { region, messages, what } = generation
    const { baseline, proposed } = region.sides()
    const snapshot = region.snapshot()

    if (this._pending && this._pending !== region) return
    this._pending = region
    const run = this.begin()
    let reply = ""

    try {
      logger.info(
        `Inline ${what} request (${model.name}): ${generation.describe}`
      )

      try {
        for await (const chunk of model.stream(messages, run.signal)) {
          if (region.broken) break
          reply += chunk
          await region.render(
            layoutDiff(baseline, generation.preview(reply), true)
          )
          this.decorate()
        }
      } catch (error) {
        if (!run.signal.aborted) throw error
      }

      if (region.broken) {
        this.clearPending()
        vscode.window.showWarningMessage(
          `Pointer stopped: the file changed under the ${what}. Undo (Ctrl+Z) reverts it.`
        )
        return
      }

      if (run.signal.aborted) {
        await this.rewind(region, snapshot)
        vscode.window.setStatusBarMessage(`Pointer: ${what} cancelled`, 3000)
        return
      }

      const final = generation.finalize(reply)
      logger.info(`Inline ${what} response: ${final.length} chars`)
      const nothing =
        what === "edit" ? "no changes suggested" : `no ${what} written`
      if (final === proposed) {
        await this.rewind(region, snapshot)
        vscode.window.setStatusBarMessage(`Pointer: ${nothing}`, 4000)
        return
      }
      const layout = layoutDiff(baseline, final)
      await region.render(layout)
      if (region.done) {
        this.clearPending()
        vscode.window.setStatusBarMessage(`Pointer: ${nothing}`, 4000)
        return
      }
      this.end()
      this.present()
    } catch (error) {
      if (!region.broken) await this.rewind(region, snapshot)
      else this.clearPending()
      if (!run.signal.aborted) {
        logger.error(error instanceof Error ? error : String(error))
        vscode.window.showErrorMessage(
          `Pointer could not write the ${what}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } finally {
      if (this._run === run) this.end()
    }
  }

  private present() {
    this.decorate()
    void vscode.commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.pointerInlineEditPending,
      true
    )
    this._emitter.fire()
    vscode.window.setStatusBarMessage(REVIEW_HINT, 8000)
  }

  private async rewind(region: DiffRegion, snapshot: DiffLayout) {
    await region.render(snapshot)
    if (region.done) {
      this.clearPending()
      await this.closeIfEmptyUntitled(region.document)
      return
    }
    this.end()
    this.decorate()
    this._emitter.fire()
  }

  private decorate() {
    const pending = this._pending
    for (const editor of vscode.window.visibleTextEditors) {
      const own = pending && editor.document === pending.document
      editor.setDecorations(
        this._removedDecoration,
        own ? pending.removed.map(lineRange) : []
      )
      editor.setDecorations(
        this._addedDecoration,
        own ? pending.added.map(lineRange) : []
      )
      editor.setDecorations(
        this._removedWords,
        own ? pending.removedWords.map(spanRange) : []
      )
      editor.setDecorations(
        this._addedWords,
        own ? pending.addedWords.map(spanRange) : []
      )
    }
  }

  private onChange(event: vscode.TextDocumentChangeEvent) {
    const pending = this._pending
    if (!pending || event.document !== pending.document) return
    const undo =
      event.reason === vscode.TextDocumentChangeReason.Undo ||
      event.reason === vscode.TextDocumentChangeReason.Redo
    if (!pending.track(event.contentChanges, this.running)) return
    if (!pending.broken) {
      this.decorate()
      this._emitter.fire()
      return
    }
    if (this.running) return
    this.clearPending()
    if (!undo) {
      vscode.window.setStatusBarMessage(
        "Pointer: the file changed under the pending edit; Undo (Ctrl+Z) reverts it.",
        6000
      )
    }
  }

  private clearPending() {
    this._pending = undefined
    this.decorate()
    void vscode.commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.pointerInlineEditPending,
      false
    )
    this._emitter.fire()
  }

  private begin() {
    const run = this._generations.start("edit")
    this._run = run
    this._emitter.fire()
    return run
  }

  private end() {
    this._run?.finish()
    this._run = undefined
    this._emitter.fire()
  }
}
