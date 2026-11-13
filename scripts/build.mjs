/* eslint-disable no-undef */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import esbuild from "esbuild"
import { copy } from "esbuild-plugin-copy";
import fs from "node:fs"
import path from "node:path"

const lanceGlibcCheck = {
  name: "lancedb-glibc-check",
  setup(build) {
    build.onLoad({ filter: /@lancedb[\\/]lancedb[\\/]dist[\\/]native\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, "utf8")
      const unsafe = "process.report.getReport().header"
      if (!source.includes(unsafe)) {
        throw new Error(`${args.path} no longer reads ${unsafe}; review the lancedb-glibc-check patch`)
      }
      return {
        contents: source.replace(
          unsafe,
          "((process.report.getReport() || {}).header || { glibcVersionRuntime: true })"
        ),
        loader: "js",
        resolveDir: path.dirname(args.path)
      }
    })
  }
};

(async () => {
  const extensionConfig = {
    bundle: true,
    entryPoints: ["src/index.ts", "src/extension/embeddings/rerank-worker.ts"],
    external: ["vscode", "esbuild", "./xhr-sync-worker.js"],
    format: "cjs",
    outdir: "out",
    platform: "node",
    sourcemap: true,
    loader: { ".node": "file" },
    assetNames: "[name]",
    plugins: [
      lanceGlibcCheck,
      copy({
        resolveFrom: "cwd",
        assets: [
          {
            from: "./node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm",
            to: "./out/ort-wasm-simd.wasm"
          },
          {
            from: "./node_modules/tree-sitter-wasms/out/**/*.wasm",
            to: "./out/tree-sitter-wasms"
          },
          {
            from: "./node_modules/web-tree-sitter/tree-sitter.wasm",
            to: "./out/tree-sitter.wasm"
          },
          {
            from: "./node_modules/web-tree-sitter/tree-sitter.wasm",
            to: "./out/tree-sitter.wasm"
          },
          {
            from: "./node_modules/web-tree-sitter/tree-sitter.wasm",
            to: "./out/tree-sitter.wasm"
          }
        ],
        watch: true,
      }),
    ]
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
