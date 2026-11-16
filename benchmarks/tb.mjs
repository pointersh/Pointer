import { rust } from "./mcp.mjs"; import fs from "node:fs"
const q = JSON.parse(fs.readFileSync(new URL("queries.json", import.meta.url)))[0]; const r = await rust(process.argv[2], process.argv[3])
const t = await r.search(q.q); const files = t.split("\n\n")[0].split("\n").filter(l => / · /.test(l)).map(l => l.split(":")[0])
console.log(files.length, "chunks;", q.gold.map(g => `${g}@${files.indexOf(g)}`).join(" ")); r.kill()
