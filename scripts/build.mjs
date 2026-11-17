import { execSync } from "node:child_process"
import fs from "node:fs"

import esbuild from "esbuild"

(async () => {
  execSync("cargo build -p pointer-highlight --profile wasm --target wasm32-unknown-unknown", { stdio: "inherit" })
  fs.copyFileSync("target/wasm32-unknown-unknown/wasm/pointer_highlight.wasm", "crates/pointer-highlight/highlight.wasm")
  execSync("npx @tailwindcss/cli -i src/webview/styles/app.css -o src/webview/styles/generated.css --minify", { stdio: "inherit" })

  const extensionConfig = {
    bundle: true,
    entryPoints: ["src/index.ts"],
    external: ["vscode", "esbuild", "./xhr-sync-worker.js"],
    format: "cjs",
    outdir: "out",
    platform: "node",
    sourcemap: true,
  }

  const webConfig = {
    bundle: true,
    external: ["vscode"],
    entryPoints: ["src/webview/index.tsx"],
    outfile: "out/sidebar.js",
    loader: { ".wasm": "binary" },
    sourcemap: true,
    plugins: [],
  }

  const flags = process.argv.slice(2);
  const production = !flags.includes("--watch");
  for (const config of [extensionConfig, webConfig]) {
    config.minify = production;
    config.define = { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") };
  }

  if (flags.includes("--watch")) {
    const ctx = await esbuild.context(webConfig);
    const ectx = await esbuild.context(extensionConfig);
    await ctx.watch();
    await ectx.watch();
  } else {
    await esbuild.build(webConfig);
    await esbuild.build(extensionConfig);
  }
})()
