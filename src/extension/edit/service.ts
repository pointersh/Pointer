import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"

import { EXTENSION_CONTEXT_NAME } from "../../common/constants"
import { logger } from "../../common/logger"
import { ChatCompletionMessage, PointerProvider } from "../../common/types"
import { GenerationRun, GenerationTracker } from "../generations"
import { isCancelled, resolveInferenceProvider } from "../inference"
import { Base } from "../providers/base"
import { describeProviderErrorPlain, isAbortError } from "../providers/errors"

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
import {
  appendTests,
  buildTestMessages,
  declaredDependencies,
  isTestFile,
  testFilePath,
  testFrameworkFor
} from "./tests"

export interface InlineEditArgs {
  uri?: vscode.Uri | string
  range?: vscode.Range
  instruction?: string
  requireSelection?: boolean
}

export type { Hunk } from "./region"

export type ChatEditMode = "apply" | "review"

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
}

const removedLines = (document: vscode.TextDocument, lines: vscode.Range): vscode.Range => {
  if (lines.end.line + 1 < document.lineCount) return new vscode.Range(lines.start.line, 0, lines.end.line + 1, 0)
  if (lines.start.line > 0) {
    return new vscode.Range(lines.start.line - 1, document.lineAt(lines.start.line - 1).range.end.character, lines.end.line, lines.end.character)
  }
  return lines
}

const outsideWorkspace = (uri: vscode.Uri) =>
  !!vscode.workspace.workspaceFolders?.length && !vscode.workspace.getWorkspaceFolder(uri)

export interface PendingEditInfo {
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

const mac = process.platform === "darwin"
const REVIEW_HINT = mac
  ? "Pointer: review the edit — ⌘⇧↩ accepts, ⌘⇧⌫ rejects"
  : "Pointer: review the edit — Ctrl+Shift+Enter accepts, Ctrl+Shift+Backspace rejects"

export class InlineEditService extends Base {
  private _run?: GenerationRun
  private _pending?: DiffRegion
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
    super(context)
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.onChange(event)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this._pending?.document === document) this.clearPending()
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate())
    )
  }

  public get running() {
    return this._run !== undefined
  }

  public dispose() {
    super.dispose()
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
    const provider = await this.requireProvider()
    if (!provider) return

    const pending = this._pending
    if (pending) {
      const editor = await this.editorFor(pending.document)
      const instruction =
        args?.instruction?.trim() ||
        (await this.askInstruction(editor, pending.range, true))
      if (!instruction) return
      await this.edit(editor, pending, instruction, provider)
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

    await this.edit(editor, new DiffRegion(editor, range), instruction, provider)
  }

  public async propose(code: string) {
    if (this.running || this._pending) {
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

  public async chatEdit(
    proposal: FileEditProposal,
    mode: ChatEditMode = "apply"
  ): Promise<ChatEditOutcome> {
    const pending = this._pending
    const uri = vscode.Uri.file(proposal.file)
    const relative = vscode.workspace.asRelativePath(uri)
    if (outsideWorkspace(uri)) {
      return { ok: false, message: `Not changed: ${relative} is outside the workspace.` }
    }
    if (this.running || (pending && (mode === "review" || pending.document.uri.fsPath === proposal.file))) {
      const where = pending ? ` in ${vscode.workspace.asRelativePath(pending.document.uri)}` : ""
      return {
        ok: false,
        message: `Not changed: an edit${where} is waiting for the user's review. Tell the user to accept or reject it, then ask again.`
      }
    }
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

    if (mode === "apply") {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(uri, proposal.text === "" ? removedLines(document, range) : range, proposal.text)
      if (!(await vscode.workspace.applyEdit(edit))) {
        return { ok: false, message: `Not changed: the editor refused the edit to ${relative}.` }
      }
      const saved = await document.save()
      const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true })
      const lastLine = document.lineCount - 1
      const start = Math.min(proposal.startLine, lastLine)
      const end = Math.min(lastLine, Math.max(start, proposal.startLine + proposal.text.split("\n").length - 1))
      editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
      logger.info(`Chat edited ${relative}:${proposal.startLine + 1}${saved ? "" : " (not saved)"}`)
      return {
        ok: true,
        message: saved
          ? `Applied and saved: ${relative} ${lines} changed.`
          : `Applied: ${relative} ${lines} changed in the editor, but the file could not be saved; commands and git will still see the old file.`
      }
    }

    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })
    const region = new DiffRegion(editor, range)
    this._pending = region
    await region.render(layoutDiff(current, proposal.text))
    editor.revealRange(region.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    this.present()
    logger.info(`Chat proposed an edit to ${relative}:${proposal.startLine + 1}`)
    return {
      ok: true,
      pending: true,
      message:
        `Proposed: the change to ${relative} ${lines} is shown in the editor for the user to accept or reject. ` +
        "It is not applied yet. Tell the user in a sentence what you changed."
    }
  }

  public async chatCreate(
    file: string,
    content: string,
    mode: ChatEditMode = "apply"
  ): Promise<ChatEditOutcome> {
    const target = vscode.Uri.file(file)
    const relative = vscode.workspace.asRelativePath(target)
    if (outsideWorkspace(target)) {
      return { ok: false, message: `Not created: ${relative} is outside the workspace.` }
    }
    if (fs.existsSync(file)) {
      return { ok: false, message: `Not created: ${relative} already exists. Use edit_file to change it.` }
    }
    if (this.running || (this._pending && mode === "review")) {
      return {
        ok: false,
        message: "Not created: an edit is waiting for the user's review. Tell the user to accept or reject it, then ask again."
      }
    }

    if (mode === "apply") {
      const edit = new vscode.WorkspaceEdit()
      edit.createFile(target, { ignoreIfExists: false, contents: Buffer.from(content, "utf8") })
      if (!(await vscode.workspace.applyEdit(edit))) {
        return { ok: false, message: `Not created: the editor refused to create ${relative}.` }
      }
      const document = await vscode.workspace.openTextDocument(target)
      if (document.isDirty) await document.save()
      await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true })
      logger.info(`Chat created ${relative}`)
      return { ok: true, message: `Created and saved ${relative}.` }
    }

    const document = await vscode.workspace.openTextDocument(target.with({ scheme: "untitled" }))
    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })
    const region = new DiffRegion(editor, new vscode.Range(0, 0, 0, 0))
    this._pending = region
    await region.render(layoutDiff("", content.endsWith("\n") ? content : `${content}\n`))
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

  public async writeTests() {
    if (this.running || this._pending) {
      vscode.window.showInformationMessage(
        "Pointer has an edit in progress. Accept or reject it first."
      )
      return
    }
    const provider = await this.requireProvider()
    if (!provider) return

    const source = vscode.window.activeTextEditor
    if (!source || source.document.uri.scheme !== "file") {
      vscode.window.showInformationMessage("Open a file to write tests for.")
      return
    }
    const document = source.document
    if (isTestFile(document.uri.fsPath)) {
      vscode.window.showInformationMessage(
        "This is a test file already. Open the code to test and try again."
      )
      return
    }

    const range = source.selection.isEmpty
      ? new vscode.Range(
          0,
          0,
          document.lineCount - 1,
          document.lineAt(document.lineCount - 1).range.end.character
        )
      : this.wholeLines(document, source.selection)
    const code = document.getText(range)
    if (!code.trim()) {
      vscode.window.showInformationMessage("There is no code to write tests for.")
      return
    }

    const target = vscode.Uri.file(testFilePath(document.uri.fsPath, document.languageId))
    const editor = await this.openTestFile(target, document.languageId, source)
    const testDocument = editor.document
    const last = testDocument.lineCount - 1
    const region = new DiffRegion(
      editor,
      new vscode.Range(last, 0, last, testDocument.lineAt(last).range.end.character)
    )
    const lastLine = testDocument.getText(region.range)
    const empty = !testDocument.getText().trim()
    const shape = (body: string) => appendTests(lastLine, empty, body)

    const messages = buildTestMessages({
      code,
      language: document.languageId,
      fileName: vscode.workspace.asRelativePath(document.uri),
      testFileName: vscode.workspace.asRelativePath(target),
      framework: testFrameworkFor(
        document.languageId,
        this.dependenciesNear(document.uri.fsPath)
      ),
      existing: empty ? undefined : testDocument.getText()
    })

    await this.generate(provider, {
      region,
      messages,
      preview: (reply) => shape(previewEdit(reply, "")),
      finalize: (reply) => {
        const body = finalizeEdit(reply, "")
        return body ? shape(body) + "\n" : lastLine
      },
      what: "tests",
      describe: JSON.stringify({
        file: vscode.workspace.asRelativePath(document.uri),
        lines: `${range.start.line + 1}-${range.end.line + 1}`,
        testFile: vscode.workspace.asRelativePath(target)
      })
    })
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
    const editor = await this.editorFor(pending.document)
    const ok = await pending.settle(editor, verdict, hunk)
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

  private async requireProvider(): Promise<PointerProvider | undefined> {
    const provider = this.getProvider()
    if (provider) return provider
    const choice = await vscode.window.showWarningMessage(
      "Pointer has no chat provider configured.",
      "Manage providers"
    )
    if (choice) {
      await vscode.commands.executeCommand("pointer.sidebar.focus")
      await vscode.commands.executeCommand("pointer.manageProviders")
    }
    return undefined
  }

  private async editorFor(document: vscode.TextDocument) {
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document === document
    )
    return visible ?? vscode.window.showTextDocument(document)
  }

  private async openTestFile(
    target: vscode.Uri,
    languageId: string,
    source: vscode.TextEditor
  ): Promise<vscode.TextEditor> {
    const exists = fs.existsSync(target.fsPath)
    const uri = exists ? target : target.with({ scheme: "untitled" })
    const shown = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === uri.toString()
    )
    if (shown) return shown
    const document = await vscode.workspace.openTextDocument(uri)
    if (!exists && document.languageId !== languageId) {
      await vscode.languages.setTextDocumentLanguage(document, languageId)
    }
    if (vscode.window.activeTextEditor !== source) {
      await vscode.window.showTextDocument(source.document, source.viewColumn)
    }
    return vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false
    })
  }

  private dependenciesNear(filePath: string): string[] {
    let dir = path.dirname(filePath)
    for (let depth = 0; depth < 12; depth++) {
      const candidate = path.join(dir, "package.json")
      if (fs.existsSync(candidate)) {
        try {
          return declaredDependencies(fs.readFileSync(candidate, "utf8"))
        } catch {
          return []
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return []
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
    provider: PointerProvider
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

    await this.generate(provider, {
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

  private async generate(provider: PointerProvider, generation: Generation) {
    const { region, messages, what } = generation
    const { baseline, proposed } = region.sides()
    const snapshot = region.snapshot()

    const inference = resolveInferenceProvider(provider)

    this._pending = region
    const run = this.begin()
    let reply = ""

    try {
      logger.info(
        `Inline ${what} request (${provider.modelName}): ${generation.describe}`
      )

      const chunks = inference.chat(
        { model: provider.modelName, messages },
        { signal: run.signal }
      )
      try {
        for await (const chunk of chunks) {
          if (region.broken) break
          reply += chunk.content
          await region.render(
            layoutDiff(baseline, generation.preview(reply), true)
          )
          this.decorate()
        }
      } catch (error) {
        if (!isCancelled(error)) throw error
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
      if (!isAbortError(error)) {
        logger.error(error instanceof Error ? error : String(error))
        vscode.window.showErrorMessage(
          `Pointer could not write the ${what}: ${describeProviderErrorPlain(error, provider)}`
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
    if (!pending.track(event.contentChanges)) return
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
