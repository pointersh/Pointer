import os from "os"
import path from "path"
import { ExtensionContext, workspace } from "vscode"

import {
  API_PROVIDERS,
  ASSISTANT,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  GLOBAL_STORAGE_KEY,
  SYSTEM,
  USER,
  WEBUI_TABS
} from "../../common/constants"
import { formatCount, logger } from "../../common/logger"
import type { ModelStatus } from "../../common/model-status"
import { kebabToSentence } from "../../common/text"
import {
  ChatCompletionMessage,
  MentionType,
  ReplyChangesView,
  PointerProvider
} from "../../common/types"
import type { ChatEditMode } from "../edit/service"
import { WorkspaceSearch } from "../embeddings/search"
import { GenerationRun, GenerationTracker } from "../generations"
import { isCancelled, readText, resolveInferenceProvider } from "../inference"
import {
  assumedContextWindow,
  contextWindowOf,
  knownContextWindow
} from "../inference/context-window"
import { modelStatusOf, placeOf, rememberLoad } from "../inference/model-status"
import { ExtensionBridge } from "../messaging/bridge"
import { Base } from "../providers/base"
import { describeProviderError, describeProviderErrorPlain, stripThinking } from "../providers/errors"
import { ProviderStore } from "../providers/store"
import { TemplateProvider } from "../templates/provider"
import { compactHistory, planContext, SMALL_CONTEXT_TOKENS } from "../tools/budget"
import { DEFAULT_MAX_STEPS, ToolLoopUsage, toolModeFor, withTools } from "../tools/loop"
import type { McpToolSpec } from "../tools/mcp"
import { WorkspaceView } from "../tools/view"
import { WorkspaceTools, workspaceTools } from "../tools/workspace"
import { getLanguage } from "../utils"

import { ChatContextBuilder } from "./context"
import { ContextEntry, formatContextEntries } from "./context-files"
import { ChatGeneration } from "./generation"
import { McpHost } from "./mcp-host"
import { ChangeStore, ReplyChanges, viewOf } from "./reply-changes"
import { ReplyChangesEditor } from "./reply-changes-editor"
import {
  ChatCommandMode,
  ChatCommandPlace,
  editorEdits,
  editorHint,
  editorKnowledge,
  indexSearch,
  normalCommand,
  openDocumentText,
  terminalCommands
} from "./tool-sinks"
import { ToolSteps } from "./tool-steps"
import { buildChatTurn } from "./turn"

const TEMPLATES_WITH_RAG = ["explain"]
const LOAD_TIMEOUT_MS = 5 * 60_000

const loadKey = (provider: PointerProvider) =>
  [provider.provider, provider.apiHostname ?? "", provider.apiPort ?? "", provider.modelName].join("|")
const shouldWarm = (provider: PointerProvider) => {
  const place = placeOf(provider)
  return place === "machine" || place === "network"
}

const MIN_STEPS_SETTING = 4
const MAX_STEPS_SETTING = 40

export class Chat extends Base {
  private _conversation: ChatCompletionMessage[] = []
  private readonly _backgroundRuns = new Set<GenerationRun>()
  private _suggestion?: GenerationRun
  private readonly _loading = new Set<string>()
  private readonly _loadErrors = new Map<string, string>()
  private readonly _bridge: ExtensionBridge
  private readonly _context: ChatContextBuilder
  private readonly _generation: ChatGeneration
  private readonly _search: WorkspaceSearch | undefined
  private readonly _steps: ToolSteps
  private readonly _stopSubscription: { dispose(): void }
  private _changes?: { store: ChangeStore; editor: ReplyChangesEditor }
  private readonly _mcp = new McpHost(
    () => this.config.get<Record<string, unknown>>("chatToolsMcpServers", {}),
    () => this.workspaceRoot()
  )
  private _preparing = false
  private _steering: { id: string; text: string }[] = []
  private _steerable = false
  private readonly _lifetime = new AbortController()
  private readonly _generations: GenerationTracker

  constructor(
    generations: GenerationTracker,
    templateDir: string | undefined,
    extensionContext: ExtensionContext,
    bridge: ExtensionBridge,
    search: WorkspaceSearch | undefined
  ) {
    super(extensionContext)
    this._generations = generations
    this._bridge = bridge
    this._search = search
    this._steps = new ToolSteps((steps) => bridge.emit(EVENT_NAME.pointerToolSteps, steps))
    this._stopSubscription = generations.onDidStop(() => this._steps.cancelWaiting())
    this._generation = new ChatGeneration(bridge, generations)
    this._context = new ChatContextBuilder(
      extensionContext,
      bridge,
      new TemplateProvider(templateDir),
      search
    )
  }


  public get cancelled(): boolean {
    return this._generation.cancelled
  }

  public abort = () => {
    this._steps.cancelWaiting()
    this._generation.abort()
  }

  public abortAll = () => {
    this.abort()
    this._suggestion?.abort()
    for (const run of [...this._backgroundRuns]) run.abort()
  }

  public answerToolApproval(id: string, run: boolean, always = false) {
    const step = this._steps.steps.find((s) => s.id === id)
    if (run && always && step?.approval === "command" && step.command) {
      const list = step.mcpTool ? GLOBAL_STORAGE_KEY.alwaysRunMcpTools : GLOBAL_STORAGE_KEY.alwaysRunCommands
      const key = `${EVENT_NAME.pointerGlobalContext}-${list}`
      const kept = this.context?.globalState.get<string[]>(key) ?? []
      const entry = step.mcpTool ?? normalCommand(step.command)
      if (!kept.includes(entry)) void this.context?.globalState.update(key, [...kept, entry])
    }
    this._steps.answer(id, run)
  }

  private approveMcp(detail: string, tool: McpToolSpec): Promise<boolean> {
    const name = `${tool.server}/${tool.tool}`
    const kept = this.context?.globalState.get<string[]>(
      `${EVENT_NAME.pointerGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunMcpTools}`
    )
    if (kept?.includes(name)) return Promise.resolve(true)
    return this._steps.approve(detail, "command", { always: true, mcpTool: name })
  }

  public get replying(): boolean {
    return this._generation.running || this._preparing
  }

  public discardReply() {
    if (!this.replying) return
    this._steps.discard()
    this._generation.discard()
  }

  private changes() {
    if (!this._changes) {
      const storage = (this.context?.storageUri ?? this.context?.globalStorageUri)?.fsPath ?? os.tmpdir()
      const store = new ChangeStore(path.join(storage, "agent-changes"))
      this._changes = { store, editor: new ReplyChangesEditor(store, openDocumentText) }
    }
    return this._changes
  }

  public openChange(id: string, file: string) {
    return this.changes().editor.openDiff(id, file)
  }

  public undoChanges(id: string, paths?: string[]) {
    return this.changes().editor.undo(id, paths)
  }

  public stopToolStep(id: string) {
    this._steps.stop(id)
  }

  public steer(id: string, text?: string) {
    this._steering = this._steering.filter((entry) => entry.id !== id)
    if (text?.trim() && this._steerable) this._steering.push({ id, text: text.trim() })
  }

  private takeSteering(): string[] {
    const taken = this._steering
    this._steering = []
    for (const { id, text } of taken) {
      this._steps.said(id, text)
      logger.info(`Chat tools · the user's message reached the model mid-reply (${formatCount(text.length)} chars)`)
    }
    return taken.map(({ text }) => text)
  }

  public dispose() {
    this.abortAll()
    super.dispose()
    this._stopSubscription.dispose()
    this._steps.cancelWaiting()
    this._lifetime.abort()
    this._mcp.dispose()
    this._generation.dispose()
  }

  public resetConversation() {
    this._conversation = []
  }

  public async completion(
    messages: ChatCompletionMessage[],
    mentions?: MentionType[]
  ): Promise<string | undefined> {
    const provider = this.start()
    if (!provider) return undefined
    this._preparing = true
    let view: WorkspaceView | undefined
    try {
      view = this.toolsView()
      if (view && this._mcp.configured) await this._mcp.ready()
      this._conversation = await buildChatTurn(messages, {
        systemPrompt: () => this._context.systemPrompt(),
        additionalContext: async (question, sources, history) => {
          const context = await this._context.additionalContext(question, sources, mentions, history)
          const hint = view ? editorHint(view) : ""
          return hint ? `${hint}\n\n${context}` : context
        }
      })
    } finally {
      this._preparing = false
    }
    return this.run(provider, "", view)
  }

  public async templateCompletion(template: string, context?: string) {
    const provider = this.start()
    if (!provider) return ""
    this._conversation = await this.buildTemplateConversation(template, context)
    return this.run(provider)
  }

  public async ask(
    display: string,
    prompt: string,
    attached: ContextEntry[] = []
  ): Promise<string> {
    const provider = this.start()
    if (!provider) return ""
    const code = formatContextEntries(attached)
    const content = (code ? `${prompt}\n\nAttached code:\n\n${code}` : prompt).trim()
    this._bridge.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.chat)
    this._bridge.emit(EVENT_NAME.pointerAddMessage, {
      role: USER,
      content: display,
      prompt: content
    })
    if (!this._conversation.length) {
      this._conversation = [
        { role: SYSTEM, content: await this._context.systemPrompt() }
      ]
    }
    this._conversation = [
      ...this._conversation,
      { role: USER, content }
    ]
    return this.run(provider)
  }

  public async streamMessages(
    messages: ChatCompletionMessage[],
    prefix = ""
  ): Promise<string> {
    const provider = this.start()
    if (!provider) return ""
    this._conversation = messages
    return this.run(provider, prefix)
  }

  public async generateSimpleCompletion(
    prompt: string
  ): Promise<string | undefined> {
    const provider = this.getProvider()
    if (!provider) {
      logger.error("No chat provider configured.")
      return undefined
    }
    const run = this._generations.start("completion")
    this._backgroundRuns.add(run)
    try {
      const content = await readText(
        resolveInferenceProvider(provider).chat(
          {
            model: provider.modelName,
            messages: [{ role: USER, content: prompt }]
          },
          { signal: run.signal }
        )
      )
      return stripThinking(content) || undefined
    } catch (error) {
      if (!isCancelled(error)) {
        logger.error(
          `Simple completion failed: ${describeProviderError(error, provider)}`
        )
      }
      return undefined
    } finally {
      run.finish()
      this._backgroundRuns.delete(run)
    }
  }


  public async modelStatus(): Promise<ModelStatus | null> {
    const provider = this.getProvider()
    if (!provider?.modelName) return null
    const key = loadKey(provider)
    const status = await modelStatusOf(provider, shouldWarm(provider))
    if (this._loading.has(key) && !status.loaded) return { ...status, loading: true }
    const failed = this._loadErrors.get(key)
    return failed && !status.loaded ? { ...status, loadError: failed } : status
  }

  public async warmModel(): Promise<ModelStatus | null> {
    const provider = this.getProvider()
    if (!provider?.modelName) return null
    const key = loadKey(provider)
    if (shouldWarm(provider) && !this._loading.has(key)) {
      this._loadErrors.delete(key)
      this._loading.add(key)
      const started = Date.now()
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), LOAD_TIMEOUT_MS)
      void readText(
        resolveInferenceProvider(provider).chat(
          { model: provider.modelName, messages: [{ role: USER, content: "Hi" }], maxTokens: 1, temperature: 0, think: false },
          { signal: abort.signal }
        )
      )
        .then(() => {
          rememberLoad(provider, Date.now() - started)
          logger.debug(`Loaded ${provider.modelName} in ${Date.now() - started}ms`)
        })
        .catch((error) => {
          const message = abort.signal.aborted
            ? `${provider.modelName} did not load within ${LOAD_TIMEOUT_MS / 60_000} minutes.`
            : describeProviderErrorPlain(error, provider)
          this._loadErrors.set(key, message)
          logger.error(`Loading ${provider.modelName} failed: ${message}`)
        })
        .finally(() => {
          clearTimeout(timer)
          this._loading.delete(key)
        })
    }
    return this.modelStatus()
  }

  private start(): PointerProvider | undefined {
    this._generation.reset()
    this._bridge.emit(EVENT_NAME.pointerSendLanguage, getLanguage())
    return this.getProvider()
  }

  private agentMode(): boolean {
    const stored = this.context?.globalState.get<boolean>(
      `${EVENT_NAME.pointerGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`
    )
    return stored ?? this.config.get<boolean>("chatTools", false)
  }

  private commandMode(setting: ChatCommandMode, command: string): "ask" | "allow" {
    const state = this.context?.globalState
    const stored = state?.get<boolean>(`${EVENT_NAME.pointerGlobalContext}-${GLOBAL_STORAGE_KEY.autoRunCommands}`)
    if (stored ?? setting === "allow") return "allow"
    const kept = state?.get<string[]>(`${EVENT_NAME.pointerGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunCommands}`)
    return kept?.includes(normalCommand(command)) ? "allow" : "ask"
  }

  protected workspaceRoot(): string | undefined {
    return workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  private toolsView(): WorkspaceView | undefined {
    if (!this.agentMode()) return undefined
    const root = this.workspaceRoot()
    if (!root) return undefined
    return new WorkspaceView(
      root,
      this.config.get<string[]>("embeddingIgnoredGlobs", []),
      openDocumentText
    )
  }

  private async run(provider: PointerProvider, prefix = "", view?: WorkspaceView) {
    let toolNotes: string | undefined
    let instructionFiles = (): string[] => []
    let tracked: ReplyChanges | undefined
    let changed: ReplyChangesView | undefined
    const usage: ToolLoopUsage = {}
    let outOfSteps = false
    void contextWindowOf(provider)
    this._steering = []
    this._steerable = !!view
    const reply = await this._generation.generate(
      view
        ? this.toolsClient(provider, view, {
            onNotes: (notes) => (toolNotes = notes),
            onUsage: (counted) => Object.assign(usage, counted),
            onTools: (tools) => (instructionFiles = () => tools.instructionFiles?.() ?? []),
            onChanges: (changes) => (tracked = changes),
            onOutOfSteps: () => (outOfSteps = true)
          })
        : resolveInferenceProvider(provider),
      { model: provider.modelName, messages: view ? this._conversation : this.fitted(provider) },
      provider,
      prefix,
      {
        toolNotes: () => toolNotes,
        keepEmpty: () => !!view && this._steps.steps.length > 0,
        settle: async () => {
          if (!tracked?.touched) return
          const record = await tracked.record()
          if (!record) return
          try {
            this.changes().store.save(record)
            changed = viewOf(record)
          } catch (error) {
            logger.warn(`Chat · could not keep what the reply changed: ${error}`)
          }
        },
        changes: () => changed,
        meta: () => {
          const contextWindow = knownContextWindow(provider)
          const instructions = instructionFiles()
          return {
            ...(instructions.length ? { instructions } : {}),
            ...(usage.promptTokens ? { promptTokens: usage.promptTokens } : {}),
            ...(usage.completionTokens ? { completionTokens: usage.completionTokens } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(outOfSteps ? { outOfSteps: true } : {})
          }
        }
      }
    ).finally(() => {
      this._steerable = false
      this._steering = []
    })
    if (reply) {
      this._conversation = [
        ...this._conversation,
        { role: ASSISTANT, content: reply }
      ]
    }
    return reply
  }

  private fitted(provider: PointerProvider): ChatCompletionMessage[] {
    const window = knownContextWindow(provider) ?? assumedContextWindow(provider)
    if (!window) return this._conversation
    const { messages, folded } = compactHistory(this._conversation, planContext(window))
    if (folded) {
      logger.info(`Chat · folded ${folded} older messages into a summary to fit the model's ${formatCount(window)}-token context`)
    }
    return messages
  }

  private toolsClient(
    provider: PointerProvider,
    view: WorkspaceView,
    hooks: {
      onNotes(notes: string | undefined): void
      onUsage(usage: ToolLoopUsage): void
      onTools(tools: WorkspaceTools): void
      onChanges(changes: ReplyChanges): void
      onOutOfSteps(): void
    }
  ) {
    this._steps.reset()
    const commandMode = this.config.get<ChatCommandMode>("chatToolsCommands", "ask")
    const editMode = this.config.get<ChatEditMode>("chatToolsEdits", "apply")
    const changes = new ReplyChanges(view.root, openDocumentText)
    hooks.onChanges(changes)
    const approveChange = (detail: string, approval: "command" | "change") =>
      this._steps.approve(detail, approval)
    const search = this._search
    const available = workspaceTools(view, [], {
      edits: editorEdits(view, editMode, approveChange, changes),
      editor: editorKnowledge(view, editMode, approveChange, changes),
      commands:
        commandMode === "off"
          ? undefined
          : terminalCommands(
              (command) => this.commandMode(commandMode, command),
              view.root,
              (command) => this._steps.approve(command, "command", { always: true }),
              {
                place: this.config.get<ChatCommandPlace>("chatToolsCommandsRunIn", "background"),
                onOutput: (output) => this._steps.progress(output),
                onStart: (stop) => this._steps.stoppable(stop),
                lifetime: this._lifetime.signal,
                changes,
                visible: (file) => view.visible(file)
              }
            ),
      codeSearch: search?.available
        ? indexSearch(search, () =>
            Number(
              this.context?.globalState.get(
                `${EVENT_NAME.pointerGlobalContext}-${EXTENSION_CONTEXT_NAME.pointerRerankThreshold}`
              )
            )
          )
        : undefined,
      mcp: this._mcp.tools.length ? this._mcp.sink((detail, tool) => this.approveMcp(detail, tool)) : undefined
    })
    hooks.onTools(available)
    let warned = false
    return withTools(resolveInferenceProvider(provider), available, {
      mode: toolModeFor(provider.provider),
      maxSteps: Math.min(MAX_STEPS_SETTING, Math.max(MIN_STEPS_SETTING, this.config.get<number>("chatToolsMaxSteps", DEFAULT_MAX_STEPS) || DEFAULT_MAX_STEPS)),
      reasoningEffort: provider.provider === API_PROVIDERS.OpenAI ? "low" : undefined,
      contextWindow: async () => {
        const told = await contextWindowOf(provider)
        if (told && told < SMALL_CONTEXT_TOKENS && !warned) {
          warned = true
          logger.warn(
            `Chat tools · ${provider.modelName} is loaded with a ${formatCount(told)}-token context. ` +
              "Tools need about 8k to work well; older results will be trimmed often. Raise the server's context length if you can."
          )
        }
        return told ?? assumedContextWindow(provider)
      },
      stepLines: false,
      tasks: this.config.get<boolean>("chatToolsTasks", true),
      onCompact: (messages) =>
        logger.info(`Chat tools · folded ${messages} older messages into a summary to fit the model's context`),
      steering: () => this.takeSteering(),
      onOutOfSteps: hooks.onOutOfSteps,
      onNotes: hooks.onNotes,
      onUsage: hooks.onUsage,
      onRequest: (chars, step, mode, tokens) =>
        logger.info(
          `Chat tools · request ${step + 1} (${mode}) · ${formatCount(chars)} chars, about ${formatCount(tokens)} tokens`
        ),
      onToolStart: (start) => this._steps.start(start),
      onStep: (step) => {
        this._steps.finish(step)
        logger.info(`Chat tools · ${step.summary}`)
      },
      onTrim: (results, tokens) =>
        logger.info(
          `Chat tools · trimmed ${results} older tool result${results === 1 ? "" : "s"} to fit the context (now about ${formatCount(tokens)} tokens)`
        ),
      onFallback: (reason, what) =>
        logger.warn(
          what === "tools"
            ? `Chat tools · ${provider.modelName} refused native tool calls, using the text protocol: ${reason}`
            : `Chat tools · ${provider.modelName} does not take a reasoning effort, carrying on without: ${reason}`
        ),
      onEnd: () => this._steps.settle()
    })
  }

  private async buildTemplateConversation(
    template: string,
    context?: string
  ): Promise<ChatCompletionMessage[]> {
    const { language } = getLanguage()
    const { prompt, selection } = await this._context.templatePrompt(
      template,
      language,
      context
    )

    this._bridge.emit(EVENT_NAME.pointerSetTab, WEBUI_TABS.chat)
    this._bridge.emit(EVENT_NAME.pointerAddMessage, {
      role: USER,
      content:
        `${kebabToSentence(template)}\n\n\n<pre><code>${selection}</code></pre>`.trim() ||
        " ",
      prompt: prompt.trim()
    })

    const rag = TEMPLATES_WITH_RAG.includes(template)
      ? await this._context.ragContext(selection, new Set())
      : undefined
    const content =
      (rag ? `${prompt}\n\nAdditional Context:\n${rag}` : prompt).trim() || " "

    return [...this._conversation, { role: USER, content }]
  }
}
