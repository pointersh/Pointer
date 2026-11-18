# Setup

## Requirements

- Node 22.14 or newer
- VS Code 1.106 or newer (Pointer opens in the secondary side bar, on the right)
- Rust (stable), with the `wasm32-unknown-unknown` target
  (`rustup target add wasm32-unknown-unknown`)

## 1. Start TrueForge

Pointer's agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge)
in local mode. `OUTBOUND_URL_ALLOWED_HOSTS` is an exclusive allowlist: it must
include loopback, where Pointer's MCP servers listen, and your model
provider's host.

```sh
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost","openrouter.ai"]' \
  npx @truefoundry/trueforge@latest --port 8790
```

## 2. Register two model providers

Pointer tries `pointer/primary` first and switches to `pointer-backup/primary`
automatically when a turn fails. Give each provider its own endpoint or key,
so that when one breaks, the other still answers.

Fill in [`agent/modelProviders.example.json`](../agent/modelProviders.example.json)
and [`agent/modelProviders.backup.example.json`](../agent/modelProviders.backup.example.json),
then register each:

```sh
curl -X PUT localhost:8790/api/v1/settings/model-providers \
  -H 'content-type: application/json' --data @my-provider.json
```

Any OpenAI-compatible endpoint works, as do TrueForge's built-in providers.
For Gemini, use the built-in `"type": "google-gemini"` provider (no `name`; its models are
`google-gemini/<model name>`). Through the OpenAI-compatible `custom` type, Gemini 3 rejects the
second call of any turn that uses tools, because the thought signatures are not passed back.
Keys stay in TrueForge and are never stored in this repository.

## 3. Build

```sh
git clone https://github.com/pointersh/Pointer.git && cd Pointer
npm ci
npm run build          # extension, webview and the highlighter's WebAssembly
cargo build --release  # retrieval engine
```

## 4. Run

Open the folder in VS Code and press F5. In the Extension Development Host,
open the repository you want to work on. On activation, Pointer:

1. starts its editor MCP server and the retrieval engine;
2. registers both with TrueForge;
3. creates or updates the `pointer` agent from
   [`agent/pointer.agent.json`](../agent/pointer.agent.json).

## Settings

| Setting | Default | |
|---|---|---|
| `pointer.trueforgeUrl` | `http://localhost:8790` | Where TrueForge runs |
| `pointer.trueforgeStartCommand` | `""` (loopback only) | What the **Start TrueForge** button runs, in the background, when TrueForge is not running; add your model host to `OUTBOUND_URL_ALLOWED_HOSTS` |
| `pointer.models` | `["pointer/primary", "pointer-backup/primary"]` | Model chain, tried in order |
| `pointer.inlineModels` | `[]` (uses `pointer.models`) | Model chain for inline edits; a fast model here (e.g. Groq) speeds up Ctrl+I |
| `pointer.reasoningEffort` | `{}` | Per-model `reasoning_effort`, e.g. `{"pointer/primary": "none"}`. Built-in defaults: DeepSeek (`pointer`) `none`, GLM (`pointer-backup`) `low`, Groq `low`, Gemini `medium` (through TrueForge Gemini otherwise does no reasoning) |
| `pointer.retrievalPath` | `target/release/pointer-retrieval` | Retrieval engine binary |
| `pointer.semanticSearch` | `false` | Add local embeddings (bge-small) to retrieval. Downloads the model once (~133 MB) and builds in the background (about 30 s for Flask); the index lives in `.pointer/`, which ignores itself |
| `pointer.embeddingIgnoredGlobs` | `[]` | Extra globs to keep out of the semantic index |
| `pointer.enableLogging` | `true` | Log to the "Pointer" output channel |

## Checks

| Command | What it checks |
|---|---|
| `npm run typecheck`, `npm run lint` | TypeScript and lint |
| `npm run check:mcp` | The editor MCP server: auth, tool list, annotations, a read |
| `npm run check:highlight` | The highlighter against the original tokenizer's saved output |
| `npm run check:trueforge` | One full live turn (read, then an approved edit) against your TrueForge |
| `cargo test --release` | Retrieval engine and highlighter |
| `benchmarks/editor.sh` | The review engine inside a real VS Code (opens a throwaway window): pending diffs never reach disk, one proposal at a time, per-hunk accept and reject, CRLF, undo |
| `benchmarks/editor.sh benchmarks/live.test.cjs <flask-dir>` | Live in a real VS Code, against your TrueForge: activation registers both MCP servers, Task A through Ctrl+I, Stop mid-stream, Task C fallback, every model unreachable |
| `node benchmarks/abc.mjs <flask-dir> [runs]` | Tasks A, B and C live through Pointer's own agent, without the UI (edits accepted as proposed), each scored by `tasks.sh`. `MODELS=` and `INLINE_MODELS=` pick models, `TASKS=ab` picks tasks, `CANCEL=1` stops Task B at random points instead, `EDITS=1` lists each edit |
| `benchmarks/tasks.sh setup\|a\|b\|c\|reset [flask-dir]` | The three fixed tasks on Flask 3.1.3: `setup` clones it with a venv, `a`/`b`/`c` verify a task after you run it in the editor, `reset` discards changes between takes |

## Repository layout

```
src/extension/             VS Code host: inline edit, editor tools, review, webview host
src/extension/trueforge/   TrueForge client, agent, inline model, setup
src/extension/mcp/         editor MCP server (streamable HTTP, bearer token)
src/webview/               React agent panel
agent/                     TrueForge agent definition and example provider config
crates/pointer-retrieval/  Rust retrieval engine, served as an MCP server
crates/pointer-highlight/  @pointersh/highlight: Rust tokenizer compiled to WebAssembly
benchmarks/                retrieval benchmarks, the live A/B/C harness and the VS Code checks
```
