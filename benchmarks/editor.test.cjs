// Runs inside a real VS Code (see editor.sh): drives the review engine through Pointer's own commands.
const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vscode = require("vscode")

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath
const file = (name, text) => {
  const full = path.join(root(), name)
  fs.writeFileSync(full, text)
  return full
}
const disk = (full) => fs.readFileSync(full, "utf8")
const open = async (full) => vscode.workspace.openTextDocument(vscode.Uri.file(full))
const buffer = async (full) => (await open(full)).getText()
const propose = (full, startLine, endLine, original, text) =>
  vscode.commands.executeCommand("pointer.chatFileEdit", { file: full, startLine, endLine, original, text })
const accept = (line) => vscode.commands.executeCommand("pointer.acceptEdit", line)
const reject = (line) => vscode.commands.executeCommand("pointer.rejectEdit", line)
const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

const tests = {
  async "accept all applies the change, leaves disk alone until saved, and undo restores"() {
    const f = file("a.py", "one\ntwo\nthree\n")
    assert.strictEqual((await propose(f, 1, 1, "two", "TWO")).ok, true)
    assert.strictEqual(disk(f), "one\ntwo\nthree\n", "nothing written to disk while pending")
    assert.strictEqual(await buffer(f), "one\ntwo\nTWO\nthree\n", "both versions shown in the buffer")
    await accept()
    assert.strictEqual(await buffer(f), "one\nTWO\nthree\n")
    await vscode.window.showTextDocument(await open(f))
    await vscode.commands.executeCommand("undo")
    await settle()
    assert.strictEqual(await buffer(f), "one\ntwo\nthree\n", "undo restores the original")
  },

  async "saving while a review is pending writes only the original to disk"() {
    const f = file("b.py", "alpha\nbeta\n")
    assert.strictEqual((await propose(f, 0, 0, "alpha", "ALPHA")).ok, true)
    await (await open(f)).save()
    await settle()
    assert.strictEqual(disk(f), "alpha\nbeta\n", "disk has no diff lines")
    assert.strictEqual(await buffer(f), "alpha\nbeta\n", "buffer back to the original")
    const g = file("b2.py", "x\n")
    assert.strictEqual((await propose(g, 0, 0, "x", "y")).ok, true, "the slot is free again")
    await reject()
  },

  async "two proposals at once queue: the second opens after the first is accepted"() {
    const f = file("c1.py", "c1\n")
    const g = file("c2.py", "c2\n")
    const first = propose(f, 0, 0, "c1", "C1")
    const second = propose(g, 0, 0, "c2", "C2")
    let secondDone = false
    second.then(() => (secondDone = true))
    assert.strictEqual((await first).ok, true)
    await settle()
    assert.strictEqual(secondDone, false, "the second waits while the first is under review")
    assert.strictEqual(await buffer(g), "c2\n", "nothing shown for the second yet")
    await accept()
    assert.strictEqual((await second).ok, true, "the second opens once the first is settled")
    await accept()
    assert.strictEqual(await buffer(f), "C1\n")
    assert.strictEqual(await buffer(g), "C2\n")
  },

  async "per-hunk accept and reject by line, and a stale line is a no-op"() {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
    const f = file("d.py", lines.join("\n") + "\n")
    const text = ["a", "B", "c", "d", "e", "f", "g", "h", "I", "j"].join("\n")
    assert.strictEqual((await propose(f, 0, 9, lines.join("\n"), text)).ok, true)
    await accept(99)
    assert.strictEqual((await buffer(f)).split("\n").length, 13, "stale hunk line changes nothing")
    await accept(1)
    await reject(8)
    assert.strictEqual(await buffer(f), "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n")
  },

  async "deleting lines leaves no blank line"() {
    const f = file("e.py", "keep\ndrop\nkeep2\n")
    assert.strictEqual((await propose(f, 1, 1, "drop", "")).ok, true)
    await accept()
    assert.strictEqual(await buffer(f), "keep\nkeep2\n")
  },

  async "CRLF files diff only the changed line"() {
    const f = file("f.py", "one\r\ntwo\r\nthree\r\n")
    const doc = await open(f)
    const before = doc.lineCount
    assert.strictEqual((await propose(f, 0, 2, "one\ntwo\nthree", "one\nTWO\nthree")).ok, true)
    assert.strictEqual(doc.lineCount, before + 1, "one removed and one added line, not the whole block")
    await accept()
    assert.strictEqual(await buffer(f), "one\r\nTWO\r\nthree\r\n")
  },

  async "reject all restores the original exactly"() {
    const f = file("g.py", "def f():\n    return 1\n")
    assert.strictEqual((await propose(f, 1, 1, "    return 1", "    return 2\n    # two")).ok, true)
    await reject()
    assert.strictEqual(await buffer(f), "def f():\n    return 1\n")
  },

  async "create refuses to write over an unsaved buffer of the same name"() {
    const target = path.join(root(), "new.py")
    const untitled = await vscode.workspace.openTextDocument(vscode.Uri.file(target).with({ scheme: "untitled" }))
    const editor = await vscode.window.showTextDocument(untitled)
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), "mine\n"))
    const outcome = await vscode.commands.executeCommand("pointer.chatFileCreate", target, "theirs\n")
    assert.strictEqual(outcome.ok, false, JSON.stringify(outcome))
    assert.strictEqual(untitled.getText(), "mine\n")
  },

  async "a proposal against changed text is refused"() {
    const f = file("h.py", "now\n")
    const outcome = await propose(f, 0, 0, "before", "after")
    assert.strictEqual(outcome.ok, false)
    assert.strictEqual(await buffer(f), "now\n")
  },

  async "a file outside the workspace is refused"() {
    const outside = path.join(path.dirname(root()), `outside-${Date.now()}.py`)
    fs.writeFileSync(outside, "x\n")
    const outcome = await propose(outside, 0, 0, "x", "y")
    fs.rmSync(outside)
    assert.strictEqual(outcome.ok, false)
  }
}

exports.run = async () => {
  await vscode.extensions.getExtension("pointer.pointer").activate()
  const results = []
  for (const [name, test] of Object.entries(tests)) {
    try {
      await test()
      results.push(`PASS  ${name}`)
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${String(error.message).split("\n").join("\n      ")}`)
    }
    await reject()
    // Revert every dirty or untitled buffer first, so closing never stops on a "save changes?" dialog.
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty && !doc.isUntitled) continue
      await vscode.window.showTextDocument(doc)
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  }
  fs.writeFileSync(process.env.POINTER_RESULTS, results.join("\n"))
  if (results.some((r) => r.startsWith("FAIL"))) throw new Error("editor checks failed")
}
