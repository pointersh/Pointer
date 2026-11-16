import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import esbuild from "esbuild"

const here = path.dirname(new URL(import.meta.url).pathname)
const repo = path.join(here, "..")
const dist = path.join(here, "dist")
const port = Number(process.env.PORT ?? 4173)

if (!fs.existsSync(path.join(repo, "out/sidebar.js"))) execSync("npm run build", { cwd: repo, stdio: "inherit" })
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist)
const copy = (from, to = path.basename(from)) => fs.copyFileSync(path.join(repo, from), path.join(dist, to))
for (const file of ["preview/index.html", "preview/panel.html", "preview/theme.css", "assets/codicon.css", "assets/codicon.ttf", "out/sidebar.js", "out/sidebar.css"]) copy(file)
copy("crates/pointer-highlight/theme.css", "highlight.css")

await esbuild.build({
  entryPoints: { host: path.join(here, "host.ts"), editor: path.join(here, "editor.ts") },
  bundle: true,
  format: "iife",
  outdir: dist,
  loader: { ".wasm": "binary" },
  logLevel: "warning"
})

if (process.argv.includes("--build")) process.exit(0)
const ctx = await esbuild.context({})
const { port: live } = await ctx.serve({ servedir: dist, port })
console.log(`Pointer preview: http://localhost:${live}`)
