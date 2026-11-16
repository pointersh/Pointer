# Setup

## Requirements

- Node 22.14 or newer
- VS Code 1.93 or newer
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

## Preview in a browser

```sh
npm run preview
```

Opens the real panel at `http://localhost:4173` beside a mock editor, without
VS Code or TrueForge. Typing anything replays a recorded multi-file task on Flask (add a `flask config` command with a test and docs): tool outputs
recorded from the real engines, approvals that pause, diffs in the editor, and
a real pytest run (60 passed). Re-record with
`node preview/record.mjs <flask-checkout> target/release/pointer-retrieval`.

## Settings

| Setting | Default | |
|---|---|---|
| `pointer.trueforgeUrl` | `http://localhost:8790` | Where TrueForge runs |
| `pointer.models` | `["pointer/primary", "pointer-backup/primary"]` | Model chain, tried in order |
| `pointer.retrievalPath` | `target/release/pointer-retrieval` | Retrieval engine binary |
| `pointer.semanticSearch` | `false` | Add local embeddings (bge-small) to retrieval. Downloads the model once (~133 MB) and builds in the background (about 30 s for Flask); the index lives in `.pointer/`, which ignores itself |

## Checks

| Command | What it checks |
|---|---|
| `npm run typecheck`, `npm run lint` | TypeScript and lint |
| `npm run check:mcp` | The editor MCP server: auth, tool list, annotations, a read |
| `npm run check:highlight` | The highlighter against the original tokenizer's saved output |
| `npm run check:trueforge` | One full live turn (read, then an approved edit) against your TrueForge |
| `cargo test --release` | Retrieval engine and highlighter |

## Repository layout

```
src/extension/             VS Code host: inline edit, editor tools, review, webview host
src/extension/trueforge/   TrueForge client, agent, inline model, setup
src/extension/mcp/         editor MCP server (streamable HTTP, bearer token)
src/webview/               React agent panel
agent/                     TrueForge agent definition and example provider config
crates/pointer-retrieval/  Rust retrieval engine, served as an MCP server
crates/pointer-highlight/  @pointersh/highlight: Rust tokenizer compiled to WebAssembly
benchmarks/                retrieval benchmark against BM25 and grep
```
