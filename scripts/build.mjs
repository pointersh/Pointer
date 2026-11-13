/* eslint-disable no-undef */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import esbuild from "esbuild"

(async () => {
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
