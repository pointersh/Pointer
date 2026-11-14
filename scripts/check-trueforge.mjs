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
export { markServerLive, registerMcpServer, upsertAgent } from "./src/extension/trueforge/client"
export { TrueForgeAgent } from "./src/extension/trueforge/agent"
export { trueforgeTextModel } from "./src/extension/trueforge/inline"
export { GenerationTracker } from "./src/extension/generations"`,
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
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "module.exports={workspace:{getConfiguration:()=>({get:()=>undefined})},window:{createOutputChannel:()=>({info(){},warn(){},error(){},debug(){},trace(){},appendLine(){},show(){},dispose(){}})}}"
      }))
    }
  }]
})
const m = await import(pathToFileURL(out).href)

let inline = ""
for await (const chunk of m.trueforgeTextModel().stream([{ role: "user", content: "Write a Python one-liner that returns 43." }], new AbortController().signal)) inline += chunk
assert.match(inline, /43/)
console.log("inline ok")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-tf-"))
fs.writeFileSync(path.join(root, "hello.py"), "def hello():\n    return 42\n")
const edit = async () => ({ ok: true, message: "Proposed for review." })
const mcp = await m.startEditorMcp({ root, extras: { edits: { mode: "review", edit, create: edit } } })
try {
  await m.registerMcpServer("pointer-editor", mcp.url, mcp.token, "Check workspace.")
  m.markServerLive("pointer-editor")
  await m.upsertAgent()
  const events = []
  let agent
  const bridge = {
    emit: (name, payload) => {
      events.push([name, payload])
      if (name === "pointer-tool-steps") for (const step of payload) if (step.status === "waiting") setTimeout(() => agent.answerToolApproval(step.id, true))
    }
  }
  agent = new m.TrueForgeAgent(bridge, new m.GenerationTracker())
  await agent.completion([{ role: "user", content: "<p>Read hello.py, then use edit_file to change 42 to 43.</p>" }])
  const final = events.filter(([name]) => name === "pointer-add-message").at(-1)?.[1]
  const tools = (final?.toolSteps ?? []).map((s) => `${s.name}:${s.status}`)
  assert.ok(final && !final.content.startsWith("**Pointer could not finish"), final?.content)
  assert.ok(tools.includes("read_file:done") && tools.includes("edit_file:done"), tools.join(", "))
  const streamed = events.filter(([name]) => name === "pointer-on-completion").length
  console.log(`agent ok · ${final.meta.model} · [${tools}] · ${streamed} stream events · ${final.meta.durationMs} ms`)
} finally {
  await mcp.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}
