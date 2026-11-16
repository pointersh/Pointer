import fs from "node:fs"; import path from "node:path"; import { rust } from "./mcp.mjs"
const [bin, root, ...names] = process.argv.slice(2)
const sets = (names.length ? names : ["queries.json"]).map(f => [path.basename(f, ".json"), JSON.parse(fs.readFileSync(new URL(f, import.meta.url)))])
const ranked = t => [...new Set(t.split("\n\n")[0].split("\n").filter(l => / · /.test(l)).map(l => l.split(":")[0]))]
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1].toFixed(1)
const rows = {}
for (const mode of process.env.MODES?.split(",") ?? ["lexical", "semantic"]) {
  const r = await rust(bin, root, mode === "semantic" ? ["--semantic"] : [])
  const t0 = performance.now()
  if (mode === "semantic") for (let s; !/semantic: ready/.test(s = await r.call("index_status"));) { if (/semantic: off/.test(s)) throw new Error(s); await new Promise(res => setTimeout(res, 100)) }
  const build = ((performance.now() - t0) / 1000).toFixed(1)
  const vec = path.join(root, ".pointer/index/vectors.bin")
  for (const [name, qs] of sets) {
    const cold = [], warm = [], ranks = []; let hit5 = 0
    for (const { q, gold, all } of qs) {
      let s = performance.now(); const files = ranked(await r.search(q)); cold.push(performance.now() - s)
      s = performance.now(); await r.search(q); warm.push(performance.now() - s)
      ranks.push(files.findIndex(f => gold.includes(f)))
      hit5 += all ? gold.every(g => files.slice(0, 5).includes(g)) : gold.some(g => files.slice(0, 5).includes(g))
    }
    const mrr = ranks.reduce((a, x) => a + (x < 0 ? 0 : 1 / (x + 1)), 0) / qs.length
    rows[`${mode} · ${name}`] = { build_s: mode === "semantic" ? build : "", embedded: r.err().match(/embedded (\d+) chunks in ([^\n]+)/)?.slice(1).join(" in ") ?? "", vectors_kb: mode === "semantic" && fs.existsSync(vec) ? Math.round(fs.statSync(vec).size / 1024) : "", cold_ms: med(cold), warm_ms: med(warm), mrr: mrr.toFixed(2), top5: `${hit5}/${qs.length}`, ranks: ranks.join(" ") }
  }
  r.kill()
}
console.table(rows)
