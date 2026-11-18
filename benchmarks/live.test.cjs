// Live Tasks A and C and cancellation inside a real VS Code, through Pointer's own activation, servers and
// commands, on a Flask 3.1.3 checkout (see editor.sh). Needs TrueForge running with pointer/primary,
// pointer-backup/primary and pointer-broken/primary (an unreachable model, as benchmarks/abc.mjs registers).
const assert = require("assert")
const { createHash } = require("crypto")
const { execFileSync, spawnSync } = require("child_process")
const fs = require("fs")
const path = require("path")
const vscode = require("vscode")

const INSTRUCTION =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."
const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath
const helpers = () => path.join(root(), "src/flask/helpers.py")
const tasks = (task) => {
  const r = spawnSync(path.join(process.env.POINTER_REPO, "benchmarks/tasks.sh"), [task, root()], { encoding: "utf8" })
  const lines = r.stdout.split("\n")
  return { ok: r.status === 0, pass: lines.filter((l) => l.startsWith("PASS")).length, total: lines.filter((l) => /^(PASS|FAIL)/.test(l)).length, out: r.stdout }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const setModels = (models) => vscode.workspace.getConfiguration("pointer").update("models", models, vscode.ConfigurationTarget.Global)

const reset = async () => {
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) continue
    await vscode.window.showTextDocument(doc)
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  execFileSync("git", ["checkout", "--", "."], { cwd: root() })
  // Open buffers reload from disk asynchronously after the checkout; wait until they match.
  for (let i = 0; i < 50; i++) {
    const stale = vscode.workspace.textDocuments.filter(
      (d) => d.uri.scheme === "file" && fs.existsSync(d.uri.fsPath) && d.getText() !== fs.readFileSync(d.uri.fsPath, "utf8")
    )
    if (!stale.length) return
    await sleep(100)
  }
}

// Select get_debug_flag the way a user would, and run Ctrl+I with the task's instruction.
const inlineEdit = async () => {
  const doc = await vscode.workspace.openTextDocument(helpers())
  const editor = await vscode.window.showTextDocument(doc)
  const lines = doc.getText().split("\n")
  const start = lines.findIndex((l) => l.startsWith("def get_debug_flag"))
  let end = start + 1
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) end++
  while (lines[end - 1] === "") end--
  const range = new vscode.Range(start, 0, end - 1, lines[end - 1].length)
  editor.selection = new vscode.Selection(range.start, range.end)
  const started = Date.now()
  await vscode.commands.executeCommand("pointer.edit", { uri: doc.uri, range, instruction: INSTRUCTION })
  return { doc, ms: Date.now() - started }
}

// Pointer registers its MCP servers with TrueForge on activation, under a per-workspace name.
const waitForRegistration = async () => {
  const tag = createHash("sha1").update(root()).digest("hex").slice(0, 8)
  for (let i = 0; i < 120; i++) {
    const list = await fetch("http://localhost:8790/api/v1/settings/mcp-servers").then((r) => r.text(), () => "")
    if (list.includes(`pointer-editor-${tag}`) && list.includes(`pointer-retrieval-${tag}`)) return tag
    await sleep(1000)
  }
  throw new Error(`pointer-editor-${tag} / pointer-retrieval-${tag} never registered with TrueForge`)
}

const tests = {
  async "activation registers both MCP servers with TrueForge"() {
    await waitForRegistration()
  },

  async "Task A: inline edit through Ctrl+I, accept, save, verify"() {
    const { doc, ms } = await inlineEdit()
    assert.ok(doc.isDirty, "a pending diff is in the buffer")
    assert.strictEqual(tasks("c").ok, true, "nothing on disk before accepting")
    await vscode.commands.executeCommand("pointer.acceptEdit")
    await doc.save()
    const check = tasks("a")
    assert.strictEqual(check.ok, true, check.out)
    return `${check.pass}/${check.total} in ${(ms / 1000).toFixed(1)} s`
  },

  async "cancel mid-stream leaves the file as it was"() {
    const original = fs.readFileSync(helpers(), "utf8")
    const running = inlineEdit()
    await sleep(700)
    await vscode.commands.executeCommand("pointer.stopGeneration")
    const { doc } = await running
    await sleep(300)
    assert.strictEqual(doc.getText(), original, "buffer back to the original")
    assert.strictEqual(tasks("c").ok, true, "git status clean")
  },

  async "Task C: unreachable primary falls back, diff shown, disk untouched"() {
    await setModels(["pointer-broken/primary", "pointer-backup/primary"])
    try {
      const { doc, ms } = await inlineEdit()
      assert.ok(doc.isDirty, "the backup model's diff is in the buffer")
      assert.strictEqual(tasks("c").ok, true, "git status shows no files changed")
      await vscode.commands.executeCommand("pointer.acceptEdit")
      await doc.save()
      const check = tasks("a")
      assert.strictEqual(check.ok, true, check.out)
      return `fallback edit ${check.pass}/${check.total} in ${(ms / 1000).toFixed(1)} s`
    } finally {
      await setModels(undefined)
    }
  },

  async "every model unreachable: clear failure, file untouched"() {
    await setModels(["pointer-broken/primary"])
    try {
      const original = fs.readFileSync(helpers(), "utf8")
      const { doc } = await inlineEdit()
      assert.strictEqual(doc.getText(), original, "no partial edit in the buffer")
      assert.strictEqual(tasks("c").ok, true, "git status clean")
    } finally {
      await setModels(undefined)
    }
  }
}

exports.run = async () => {
  await vscode.extensions.getExtension("pointer.pointer").activate()
  const results = []
  for (const [name, test] of Object.entries(tests)) {
    try {
      const note = await test()
      results.push(`PASS  ${name}${note ? ` · ${note}` : ""}`)
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${String(error.message).split("\n").join("\n      ")}`)
    }
    await vscode.commands.executeCommand("pointer.rejectEdit")
    await reset()
  }
  fs.writeFileSync(process.env.POINTER_RESULTS, results.join("\n"))
  if (results.some((r) => r.startsWith("FAIL"))) throw new Error("live checks failed")
}
