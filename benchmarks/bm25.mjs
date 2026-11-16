import fs from "node:fs"; import path from "node:path"
const root = process.argv[2]; const qs = JSON.parse(fs.readFileSync(new URL("queries.json", import.meta.url)))
const EXT = /\.(py|rst|md|txt|toml|cfg|html)$/
const STOP = new Set("a an the and or of to in for with is are be by on at as it this that from where how what which".split(" "))
const tok = s => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t))
const t0 = performance.now()
const files = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith(".")) continue; const p = path.join(d, e.name); e.isDirectory() ? walk(p) : EXT.test(e.name) && files.push(p) } }; walk(root)
const docs = []
for (const f of files) { const lines = fs.readFileSync(f, "utf8").split("\n"); for (let i = 0; i < lines.length; i += 40) docs.push({ f: path.relative(root, f), t: tok(path.relative(root, f) + " " + lines.slice(i, i + 40).join("\n")) }) }
const df = new Map(); let total = 0
for (const d of docs) { total += d.t.length; d.tf = new Map(); for (const t of d.t) d.tf.set(t, (d.tf.get(t) ?? 0) + 1); for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1) }
const avg = total / docs.length, N = docs.length
const index = performance.now() - t0
const out = []
for (const { q } of qs) {
  const s = performance.now(); const terms = tok(q)
  const scored = docs.map(d => { let sc = 0; for (const t of terms) { const tf = d.tf.get(t); if (!tf) continue; const idf = Math.log(1 + (N - df.get(t) + .5) / (df.get(t) + .5)); sc += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * d.t.length / avg)) } return [sc, d.f] }).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0])
  out.push({ ms: performance.now() - s, files: [...new Set(scored.map(x => x[1]))] })
}
console.log(JSON.stringify({ index, out }))
