import fs from "node:fs"; import { execFileSync, spawnSync } from "node:child_process"; import { rust } from "./mcp.mjs"
const root = process.argv[2], bin = process.argv[3], file = process.argv[4] ?? "queries.json", RG = process.env.RG ?? "rg"
const qs = JSON.parse(fs.readFileSync(new URL(file, import.meta.url)))
const STOP = new Set("a an the and or of to in for with is are be by on at as it this that from where how what which add".split(" "))
const score = (files) => {
  let mrr = 0, hit5 = 0
  const rows = qs.map((q, i) => { const r = files[i].findIndex(f => q.gold.includes(f)); mrr += r < 0 ? 0 : 1 / (r + 1); const top5 = files[i].slice(0, 5); const ok = q.all ? q.gold.every(g => top5.includes(g)) : q.gold.some(g => top5.includes(g)); hit5 += ok; return r })
  return { ranks: rows.join(" "), mrr: (mrr / qs.length).toFixed(2), hit5: `${hit5}/${qs.length}`, taskB: files[0].slice(0, 5).filter(f => qs[0].gold.includes(f)).length + "/3" }
}
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2)
const results = {}
{ const r = await rust(bin, root); const ms = [], files = []
  for (const { q } of qs) { await r.search(q); const s = performance.now(); const t = await r.search(q); ms.push(performance.now() - s); files.push([...new Set(t.split("\n").filter(l => / · /.test(l)).map(l => l.split(":")[0]))]) }
  results["Rust: BM25 + symbols + PageRank (MCP over HTTP)"] = { index: r.ready.toFixed(0), q: med(ms), ...score(files) }; r.kill() }
for (const [name, cmd, args] of [["JS: plain BM25 (Node)", "node", [new URL("bm25.mjs", import.meta.url).pathname, root, file]], ["Python: plain BM25", "python3", [new URL("bm25.py", import.meta.url).pathname, root, file]]]) {
  const s = performance.now(); const o = JSON.parse(execFileSync(cmd, args, { maxBuffer: 1 << 26 })); const wall = performance.now() - s
  results[name] = { index: o.index.toFixed(0), q: med(o.out.map(x => x.ms)), ...score(o.out.map(x => x.files)), cold: wall.toFixed(0) }
}
{ const ms = [], files = []
  for (const { q } of qs) { const terms = [...new Set(q.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 2 && !STOP.has(t)))]
    const s = performance.now(); const o = spawnSync(RG, ["-c", "-i", "-w", ...terms.flatMap(t => ["-e", t]), "."], { cwd: root, argv0: "rg", encoding: "utf8" }).stdout
    const per = new Map(o.trim().split("\n").filter(Boolean).map(l => { const i = l.lastIndexOf(":"); return [l.slice(0, i).replace(/^\.\//, ""), +l.slice(i + 1)] }))
    ms.push(performance.now() - s); files.push([...per].sort((a, b) => b[1] - a[1]).map(x => x[0])) }
  results["ripgrep: OR of query words, rank by hit count"] = { index: "0", q: med(ms), ...score(files) } }
{ const ms = [], files = []
  for (const { q } of qs) { const terms = [...new Set(q.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 2 && !STOP.has(t)))]
    const s = performance.now(); const o = spawnSync("git", ["grep", "-c", "-i", "-w", ...terms.flatMap(t => ["-e", t])], { cwd: root, argv0: "rg", encoding: "utf8" }).stdout
    const per = new Map(o.trim().split("\n").filter(Boolean).map(l => { const i = l.lastIndexOf(":"); return [l.slice(0, i), +l.slice(i + 1)] }))
    ms.push(performance.now() - s); files.push([...per].sort((a, b) => b[1] - a[1]).map(x => x[0])) }
  results["git grep: same"] = { index: "0", q: med(ms), ...score(files) } }
console.table(results)
if (process.env.RANKS) for (const [n, r] of Object.entries(results)) console.log(n, r.ranks)
