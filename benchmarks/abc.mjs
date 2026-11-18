// Live Tasks A, B and C on Flask 3.1.3 through Pointer's own TrueForge client, inline-edit prompt and agent,
// without the VS Code UI (edits are accepted as proposed). Each result is checked with benchmarks/tasks.sh.
//   node benchmarks/abc.mjs <flask-dir> [runs=1]
// Needs: TrueForge on pointer.trueforgeUrl (default :8790) with pointer/primary and pointer-backup/primary,
// OUTBOUND_URL_ALLOWED_HOSTS including 127.0.0.1, `benchmarks/tasks.sh setup <flask-dir>`, `cargo build --release`.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import esbuild from "esbuild"

const [flaskArg, runsArg] = process.argv.slice(2)
if (!flaskArg) throw new Error("usage: node benchmarks/abc.mjs <flask-dir> [runs=1]")
const flask = path.resolve(flaskArg)
const runs = Number(runsArg ?? 1)
// MODELS=a/primary,b/primary sets the chain for A and B; C always puts an unreachable model in front of it.
const chain = process.env.MODELS?.split(",").filter(Boolean)
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const tasksSh = path.join(repo, "benchmarks/tasks.sh")

const INSTRUCTION_A =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."
const PROMPT_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.'

const out = path.join(os.tmpdir(), "pointer-abc.cjs")
await esbuild.build({
  stdin: {
    contents: `export { startEditorMcp } from "./src/extension/mcp/server"
export { markServerLive, registerMcpServer, serverName, setRetrievalEndpoint, trueforgeUrl } from "./src/extension/trueforge/client"
export { TrueForgeAgent } from "./src/extension/trueforge/agent"
export { trueforgeTextModel } from "./src/extension/trueforge/inline"
export { GenerationTracker } from "./src/extension/generations"
export { buildEditMessages, clampContext, EDIT_CONTEXT_LINES, finalizeEdit } from "./src/extension/edit/prompt"`,
    resolveDir: repo,
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
        contents: `const notices = (globalThis.__notices = [])
module.exports = {
  workspace: { getConfiguration: () => ({ get: (key) => (key === "models" ? globalThis.__models : undefined) }) },
  window: {
    setStatusBarMessage: (m) => notices.push(m),
    showWarningMessage: async () => undefined,
    createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, show() {}, dispose() {} })
  }
}`
      }))
    }
  }]
})
const m = await import(pathToFileURL(out).href)
await fetch(`${m.trueforgeUrl()}/api/v1/agents`).catch(() => {
  console.log(`TrueForge is not reachable at ${m.trueforgeUrl()}. Start it first (docs/setup.md).`)
  process.exit(2)
})

const tasks = (task) => {
  const r = spawnSync(tasksSh, [task, flask], { encoding: "utf8" })
  const lines = r.stdout.split("\n")
  return { ok: r.status === 0, pass: lines.filter((l) => l.startsWith("PASS")).length, fail: lines.filter((l) => l.startsWith("FAIL")).map((l) => l.slice(6)) }
}
const reset = () => tasks("reset")

// ---- Task A: the same prompt the editor's Ctrl+I builds for get_debug_flag, streamed, then written back.
const inlineEdit = async () => {
  const file = path.join(flask, "src/flask/helpers.py")
  const lines = fs.readFileSync(file, "utf8").split("\n")
  const start = lines.findIndex((l) => l.startsWith("def get_debug_flag"))
  let end = start + 1
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) end++
  while (lines[end - 1] === "") end--
  const code = lines.slice(start, end).join("\n")
  const messages = m.buildEditMessages({
    instruction: INSTRUCTION_A,
    code,
    language: "python",
    fileName: "src/flask/helpers.py",
    before: m.clampContext(lines.slice(Math.max(0, start - m.EDIT_CONTEXT_LINES), start).join("\n") + "\n", true),
    after: m.clampContext(lines.slice(end, end + m.EDIT_CONTEXT_LINES).join("\n"), false)
  })
  const started = Date.now()
  let first = 0
  let reply = ""
  for await (const chunk of m.trueforgeTextModel().stream(messages, new AbortController().signal)) {
    first ||= Date.now() - started
    reply += chunk
  }
  const total = Date.now() - started
  return {
    first,
    total,
    apply: () => {
      lines.splice(start, end - start, ...m.finalizeEdit(reply, code).split("\n"))
      fs.writeFileSync(file, lines.join("\n"))
    }
  }
}

// ---- Task B: the real agent loop, editor MCP and Rust retrieval on the checkout; proposals are accepted as made.
const retrieval = spawn(path.join(repo, "target/release/pointer-retrieval"), ["--root", flask, "--exit-with-stdin"], { stdio: ["pipe", "pipe", "ignore"] })
const engine = await new Promise((resolve, reject) => {
  retrieval.on("exit", () => reject(new Error("pointer-retrieval exited; run cargo build --release")))
  retrieval.stdout.on("data", (d) => {
    const ready = /READY (\S+) (\S+)/.exec(String(d))
    if (ready) resolve({ url: ready[1], token: ready[2] })
  })
})
const venv = path.join(flask, ".venv/bin")
const editor = await m.startEditorMcp({
  root: flask,
  extras: {
    edits: {
      edit: async (file, r) => {
        const lines = fs.readFileSync(file, "utf8").split("\n")
        lines.splice(r.startLine, r.endLine - r.startLine + 1, ...(r.text === "" ? [] : r.text.split("\n")))
        fs.writeFileSync(file, lines.join("\n"))
        return { ok: true, message: `Applied to ${path.relative(flask, file)}.` }
      },
      create: async (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
        return { ok: true, message: `Created ${path.relative(flask, file)}.` }
      }
    },
    commands: {
      run: async (command) => {
        const r = spawnSync("/bin/bash", ["-c", command], { cwd: flask, encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${venv}:${process.env.PATH}` } })
        return { ran: true, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-4000), exitCode: r.status ?? 1 }
      }
    }
  }
})
await m.registerMcpServer(m.serverName("pointer-editor"), editor.url, editor.token, "Flask checkout for the A/B/C benchmark.")
m.markServerLive("pointer-editor")
await m.registerMcpServer(m.serverName("pointer-retrieval"), engine.url, engine.token, "Ranked code retrieval over the Flask checkout.")
m.markServerLive("pointer-retrieval")
m.setRetrievalEndpoint(engine)

const TASK_LIMIT_MS = 8 * 60_000
const agentTask = async (prompt) => {
  // Only the final message is kept: streamed updates carry the whole reply each time.
  const events = []
  let streamed = 0
  let streamedAt = Date.now()
  let longestQuiet = 0
  let agent
  const bridge = {
    emit: (name, payload) => {
      if (name === "pointer-on-completion") {
        const length = String(payload?.content ?? "").length
        if (length !== streamed) {
          longestQuiet = Math.max(longestQuiet, Date.now() - streamedAt)
          streamed = length
          streamedAt = Date.now()
        }
      } else events.push([name, payload])
      if (name === "pointer-tool-steps") for (const step of payload) if (step.status === "waiting") setTimeout(() => agent.answerToolApproval(step.id, true))
    }
  }
  agent = new m.TrueForgeAgent(bridge, new m.GenerationTracker())
  const limit = setTimeout(() => agent.abort(), TASK_LIMIT_MS)
  await agent.completion([{ role: "user", content: `<p>${prompt}</p>` }])
  clearTimeout(limit)
  const final = events.filter(([name]) => name === "pointer-add-message").at(-1)?.[1]
  const steps = final?.toolSteps ?? []
  const searched = steps.filter((s) => s.name === "search_codebase").map((s) => s.output ?? "").join("\n")
  const target = ["src/flask/cli.py", "tests/test_cli.py", "docs/cli.rst"]
  return {
    failed: !final || final.content.startsWith("**Pointer could not finish") || !!final.meta?.stopped,
    error: final?.meta?.stopped ? `stopped after ${TASK_LIMIT_MS / 60_000} min` : final?.content.slice(0, 200),
    model: final?.meta?.model,
    ms: final?.meta?.durationMs,
    tokens: (final?.meta?.promptTokens ?? 0) + (final?.meta?.completionTokens ?? 0),
    calls: final?.meta?.modelCalls,
    streamedChars: streamed,
    longestQuiet: Math.round(longestQuiet / 1000),
    steps: steps.length,
    searches: steps.filter((s) => s.name === "search_codebase").length,
    tools: Object.entries(steps.reduce((n, s) => ({ ...n, [s.name]: (n[s.name] ?? 0) + 1 }), {})).map(([k, v]) => `${k}×${v}`).join(" "),
    pointedAt: target.filter((f) => searched.includes(f)).length
  }
}

// ---- Task C: an unreachable primary in the chain; the backup must answer and the failure must write nothing.
const registerBroken = async () => {
  const response = await fetch(`${m.trueforgeUrl()}/api/v1/settings/model-providers`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      manifest: { type: "custom", name: "pointer-broken", base_url: "http://127.0.0.1:9/v1", auth: { api_key: "invalid" }, models: [{ name: "primary", model_id: "none", properties: { context_length: 128000 } }] }
    })
  })
  if (!response.ok) throw new Error(`could not register the broken provider: ${response.status} ${await response.text()}`)
}

const rows = []
try {
  await registerBroken()
  for (let run = 1; run <= runs; run++) {
    const row = { run }
    reset()
    globalThis.__models = chain
    const a = await inlineEdit().catch((error) => ({ error }))
    if (a.error) row.A = `error: ${String(a.error.message).slice(0, 100)}`
    else {
      a.apply()
      const checkA = tasks("a")
      Object.assign(row, { A: `${checkA.pass}/${checkA.pass + checkA.fail.length}`, "A first token": `${a.first} ms`, "A total": `${a.total} ms` })
    }

    reset()
    const b = await agentTask(PROMPT_B)
    const checkB = tasks("b")
    Object.assign(row, {
      B: b.failed ? `error: ${b.error}` : `${checkB.pass}/${checkB.pass + checkB.fail.length}`,
      "B time": `${Math.round((b.ms ?? 0) / 1000)} s`,
      "B steps": b.steps,
      "B pointed at": `${b.pointedAt}/3 files`,
      "B tools": b.tools,
      "B model calls": b.calls,
      "B model": b.model,
      "B reply chars (with reasoning)": b.streamedChars,
      "B longest quiet": `${b.longestQuiet} s`,
      "B tokens": b.tokens
    })
    if (checkB.fail.length) row["B failed"] = checkB.fail.join("; ")

    reset()
    globalThis.__models = ["pointer-broken/primary", ...(chain ?? ["pointer-backup/primary"])]
    globalThis.__notices.length = 0
    const c = await inlineEdit().catch((error) => ({ error }))
    const clean = tasks("c").ok
    let cA = "no edit"
    if (!c.error) {
      c.apply()
      const check = tasks("a")
      cA = `${check.pass}/${check.pass + check.fail.length}`
    }
    Object.assign(row, {
      C: c.error ? `error: ${String(c.error.message).slice(0, 80)}` : `fell back in ${c.total} ms`,
      "C notice": globalThis.__notices.some((n) => /retrying on /.test(n)) ? "shown" : "missing",
      "C clean before accept": clean ? "yes" : "NO",
      "C backup's edit": cA
    })
    rows.push(row)
    console.log(row)
  }
} finally {
  reset()
  await editor.dispose()
  retrieval.kill()
}
console.table(rows)
