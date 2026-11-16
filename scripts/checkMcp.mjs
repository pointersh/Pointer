import assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import esbuild from "esbuild"

const out = path.join(process.env.CHECK_OUT ?? os.tmpdir(), "check-mcp.cjs")
await esbuild.build({ entryPoints: ["src/extension/mcp/server.ts"], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent" })
const { startEditorMcp } = await import(pathToFileURL(out).href)

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-mcp-"))
fs.writeFileSync(path.join(root, "hello.py"), "def hello():\n    return 42\n")
const outcome = async () => ({ ok: true, message: "proposed" })
const mcp = await startEditorMcp({
  root,
  extras: { edits: { edit: outcome, create: outcome }, commands: { run: async () => ({ ran: false, output: "" }) } }
})

const rpc = (method, params, token = mcp.token) =>
  fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  })

try {
  assert.strictEqual((await rpc("tools/list", {}, null)).status, 401)
  assert.strictEqual((await rpc("tools/list", {}, "wrong")).status, 401)
  const list = await (await rpc("tools/list", {})).json()
  const tools = list.result.tools
  const read = tools.find((t) => t.name === "read_file")
  assert.ok(read, "read_file listed")
  assert.strictEqual(read.annotations.readOnlyHint, true)
  for (const name of ["edit_file", "create_file", "run_command"]) {
    const tool = tools.find((t) => t.name === name)
    assert.ok(tool, `${name} listed`)
    assert.strictEqual(tool.annotations.readOnlyHint, false)
    assert.strictEqual(tool.annotations.destructiveHint, true)
  }
  const call = await (await rpc("tools/call", { name: "read_file", arguments: { path: "hello.py" } })).json()
  assert.match(call.result.content[0].text, /return 42/)
  const missing = await (await rpc("tools/call", { name: "read_file", arguments: { path: "nope.py" } })).json()
  assert.strictEqual(missing.result.isError, true)
  assert.match(missing.result.content[0].text, /nope\.py does not exist/)
  console.log(`mcp ok: ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`)
} finally {
  await mcp.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}
