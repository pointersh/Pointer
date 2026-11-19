// The inline-edit syntax gate on real code: every top-level function in a few Flask files, edited the way
// models break code, checked by pointer-retrieval's check_syntax (tree-sitter) over MCP. Reports what the gate
// catches, what it wrongly blocks (valid edits), and how long a check takes.
//   node benchmarks/syntax.mjs <flask> target/release/pointer-retrieval
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const [root, bin] = process.argv.slice(2)
const FILES = ["src/flask/helpers.py", "src/flask/cli.py", "src/flask/app.py", "src/flask/config.py"]

// Each edit takes a function's lines and returns them changed. valid: the gate must let it through.
const EDITS = {
  "valid: unchanged": { valid: true, edit: (l) => l },
  "valid: body line added": { valid: true, edit: (l) => { const b = body(l); return b > 0 && b < l.length ? [...l.slice(0, b), `${indent(l[b])}_unused = None`, ...l.slice(b)] : undefined } },
  "valid: return value wrapped": { valid: true, edit: (l) => changed(l, l.map((x) => (balanced(x) && !x.includes("#") ? x.replace(/^(\s+)return (.+)$/, "$1return ($2)") : x))) },
  "broken: closing bracket dropped": { edit: (l) => dropLast(l, /\)(?=[^)]*$)/) },
  "broken: colon after def dropped": { edit: (l) => { const b = body(l); return changed(l, l.map((x, i) => (i === b - 1 ? x.replace(/:\s*$/, "") : x))) } },
  "broken: string left open": { edit: (l) => dropLast(l, /"(?=[^"]*$)/) },
  "broken: quotes double-escaped": { edit: (l) => changed(l, l.map((x) => x.replace(/"/g, '\\"'))) },
  "broken: reply cut off mid-function": { edit: (l) => cutMid(l) }
}
// The first body line: the one after the signature's closing colon (signatures can span lines).
const body = (lines) => lines.findIndex((x) => /:\s*(#.*)?$/.test(x)) + 1
// undefined when an edit found nothing to change, so it is not counted.
const changed = (before, after) => (after.some((x, i) => x !== before[i]) ? after : undefined)
const balanced = (x) => [..."([{"].every((open, i) => x.split(open).length === x.split(")]}"[i]).length)
const indent = (line = "    ") => /^\s*/.exec(line)[0] || "    "
const dropLast = (lines, re) => {
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return lines.map((x, j) => (j === i ? x.replace(re, "") : x))
  return undefined
}
const cutMid = (lines) => {
  const i = lines.findIndex((x, j) => j > 0 && /[([{]\s*$/.test(x))
  return i > 0 ? lines.slice(0, i + 1) : undefined
}

const functions = (text) => {
  const lines = text.split("\n")
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^def \w+/.test(lines[i])) continue
    let end = i + 1
    while (end < lines.length && (lines[end] === "" || /^[\s)\]]/.test(lines[end]))) end++
    while (lines[end - 1] === "") end--
    out.push({ start: i, end })
  }
  return { lines, out }
}

const child = spawn(bin, ["--root", root, "--exit-with-stdin"], { stdio: ["pipe", "pipe", "ignore"] })
const ready = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /READY (\S+) (\S+)/.exec(String(d)); if (m) resolve({ url: m[1], token: m[2] }) }))
const client = new Client({ name: "syntax-bench", version: "0" })
await client.connect(new StreamableHTTPClientTransport(new URL(ready.url), { requestInit: { headers: { Authorization: `Bearer ${ready.token}` } } }))
const check = async (file, text) => {
  const started = performance.now()
  const result = await client.callTool({ name: "check_syntax", arguments: { path: file, text } })
  return { verdict: result.content[0].text, ms: performance.now() - started }
}

const rows = Object.fromEntries(Object.keys(EDITS).map((k) => [k, { cases: 0, blocked: 0 }]))
const times = []
for (const file of FILES) {
  const { lines, out } = functions(fs.readFileSync(path.join(root, file), "utf8"))
  if ((await check(file, lines.join("\n"))).verdict !== "ok") throw new Error(`${file} does not parse before any edit`)
  for (const fn of out) {
    for (const [name, { edit }] of Object.entries(EDITS)) {
      const changed = edit(lines.slice(fn.start, fn.end))
      if (!changed) continue
      const { verdict, ms } = await check(file, [...lines.slice(0, fn.start), ...changed, ...lines.slice(fn.end)].join("\n"))
      times.push(ms)
      rows[name].cases++
      if (verdict.startsWith("error")) rows[name].blocked++
      if (!verdict.startsWith("error") && !EDITS[name].valid) console.log(`missed: ${file}:${fn.start + 1} ${name}`)
      if (verdict.startsWith("error") && EDITS[name].valid) console.log(`blocked a valid edit: ${file}:${fn.start + 1} ${name} (${verdict})\n${changed.slice(0, 4).join("\n")}`)
    }
  }
}
await client.close()
child.kill()

times.sort((a, b) => a - b)
const pct = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(1)
console.table(Object.entries(rows).map(([edit, r]) => ({ edit, cases: r.cases, blocked: `${r.blocked}/${r.cases}` })))
console.log(`${times.length} checks over ${FILES.length} Flask files; check_syntax median ${pct(0.5)} ms, p95 ${pct(0.95)} ms (whole file, MCP over HTTP)`)
