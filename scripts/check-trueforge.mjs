import assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import esbuild from "esbuild"

const out = path.join(process.env.CHECK_OUT ?? os.tmpdir(), "check-trueforge.cjs")
await esbuild.build({
  stdin: {
    contents: `export { startEditorMcp } from "./src/extension/mcp/server"
export { registerMcpServer } from "./src/extension/trueforge/client"
export { createSession, runTurn } from "./src/extension/trueforge/session"`,
    resolveDir: process.cwd(),
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "silent",
  plugins: [{
    name: "vscode",
    setup: (b) => {
      b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }))
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports={workspace:{getConfiguration:()=>({get:()=>undefined})}}" }))
    }
  }]
})
const { startEditorMcp, registerMcpServer, createSession, runTurn } = await import(pathToFileURL(out).href)

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-tf-"))
fs.writeFileSync(path.join(root, "hello.py"), "def hello():\n    return 42\n")
const edit = async () => ({ ok: true, message: "Proposed for review." })
const mcp = await startEditorMcp({ root, extras: { edits: { mode: "review", edit, create: edit } } })
try {
  await registerMcpServer("pointer-check", mcp.url, mcp.token, "Check workspace.")
  const session = await createSession({
    spec: { model: { name: process.env.CHECK_MODEL ?? "pointer/primary" }, mcp_servers: [{ name: "pointer-check", preload: true }] }
  })
  const calls = []
  let texts = 0
  let approvals = 0
  const result = await runTurn(session, "Read hello.py, then use edit_file to change 42 to 43.", {
    onText: () => texts++,
    onToolCall: (call) => calls.push(call.name),
    onApproval: async () => (approvals++, true)
  }, new AbortController().signal)
  assert.strictEqual(result.status, "done", result.error)
  assert.ok(calls.includes("read_file") && calls.includes("edit_file"), calls.join(", "))
  assert.ok(approvals > 0, "edit_file paused for approval")
  console.log(`ok · ${result.model} · tools [${calls}] · approvals ${approvals} · ${texts} stream updates`)
} finally {
  await mcp.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}
