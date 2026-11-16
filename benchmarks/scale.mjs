import { execFileSync, spawnSync } from "node:child_process"; import { rust } from "./mcp.mjs"
const [bin, ...roots] = process.argv.slice(2)
const QS = ["where are database migrations applied", "how is the request routed to a view", "password hashing", "template rendering context", "middleware that handles sessions", "add a new management command", "json serialization of responses", "cache backend configuration"]
const rss = (pid) => +execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim() / 1024
const peak = (cmd, args) => { const o = spawnSync("/usr/bin/time", ["-l", cmd, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }); const m = o.stderr.match(/(\d+)\s+maximum resident set size/); return { mb: m ? +m[1] / 1048576 : NaN, out: o.stdout } }
const rows = {}
for (const root of roots) {
  const name = root.split("/").at(-1)
  const r = await rust(bin, root)
  await new Promise(res => setTimeout(res, 300))
  const m = r.err().match(/indexed (\d+) files, (\d+) chunks/)
  const ms = []; let bytes = 0
  for (const q of QS) { await r.search(q); const s = performance.now(); const t = await r.search(q); ms.push(performance.now() - s); bytes = Math.max(bytes, t.length) }
  rows[`${name} · Rust`] = { files: +m[1], chunks: +m[2], ready_ms: Math.round(r.ready), query_ms: [...ms].sort((a, b) => a - b)[ms.length >> 1].toFixed(1), rss_mb: rss(r.pid).toFixed(0), max_response_chars: bytes }
  r.kill()
  for (const [label, cmd, file] of [["Node BM25", "node", "bm25.mjs"], ["Python BM25", "python3", "bm25.py"]]) {
    const s = performance.now(); const { mb, out } = peak(cmd, [new URL(file, import.meta.url).pathname, root]); const wall = performance.now() - s
    const o = JSON.parse(out); rows[`${name} · ${label}`] = { ready_ms: Math.round(wall), query_ms: [...o.out.map(x => x.ms)].sort((a, b) => a - b)[o.out.length >> 1].toFixed(1), rss_mb: mb.toFixed(0) }
  }
}
console.table(rows)
