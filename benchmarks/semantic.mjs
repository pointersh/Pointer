import fs from "node:fs"; import { rust } from "./mcp.mjs"
const [bin, root] = process.argv.slice(2)
const qs = JSON.parse(fs.readFileSync(new URL("queries.json", import.meta.url)))
const r = await rust(bin, root, ["--semantic"])
const t0 = performance.now()
const done = await r.waitFor(/embedded (\d+) chunks in ([^\n]+)/)
const build = performance.now() - t0
const ms = [], ranks = []
for (const { q, gold } of qs) {
  await r.search(q); const s = performance.now(); const t = await r.search(q); ms.push(performance.now() - s)
  const files = [...new Set(t.split("\n\n")[0].split("\n").filter(l => / · /.test(l)).map(l => l.split(":")[0]))]
  ranks.push(files.findIndex(f => gold.includes(f)))
}
const tb = (await r.search(qs[0].q)).split("\n\n")[0].split("\n").filter(l => / · /.test(l)).map(l => l.split(":")[0])
const mrr = ranks.reduce((a, x) => a + (x < 0 ? 0 : 1 / (x + 1)), 0) / qs.length
console.log(JSON.stringify({ ready: Math.round(r.ready), build: Math.round(build), chunks: +done[1], q: [...ms].sort((a, b) => a - b)[ms.length >> 1].toFixed(1), ranks: ranks.join(" "), mrr: mrr.toFixed(2), hit5: ranks.filter(x => x >= 0 && x < 5).length, taskB: qs[0].gold.map(g => `${g}@${tb.indexOf(g)}`).join(" ") }))
r.kill()
