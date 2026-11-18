// vsce runs this before packaging: build the retrieval engine and refuse to package without it.
// ponytail: ships the host platform's binary only; package each OS with `vsce package --target <platform>` on that OS.
import { execSync } from "node:child_process"
import fs from "node:fs"

execSync("npm run build && cargo build --release -p pointer-retrieval", { stdio: "inherit" })
const bin = ["target/release/pointer-retrieval", "target/release/pointer-retrieval.exe"].find(fs.existsSync)
if (!bin) { console.error("pointer-retrieval was not built; refusing to package without the retrieval engine."); process.exit(1) }
console.log(`packaging with ${bin}`)
