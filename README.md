<p align="center"><img src="assets/icon.png" width="96" alt="Pointer"></p>

# Pointer

An editor-native coding agent for VS Code whose agent loop runs on
[TrueForge](https://github.com/truefoundry/trueforge). Pointer finds the right
code in a repository too large for any context window, proposes multi-file
changes, and shows every hunk for review before anything touches disk.

> **Beta.** The editor side (inline edit, agent panel, per-hunk review,
> undo, editor tools) is in place; the TrueForge client and MCP server are being
> wired in. See [PRD.md](PRD.md).

## Features

- **Inline edit:** select code, press Ctrl+I (⌘I), and describe the change. The
  diff streams into the editor; accept or reject each hunk.
- **Agent mode:** one request drives a TrueForge agent through Pointer's editor
  tools (read, search, propose write, run command) until the task is done.
- **Context:** `@file` and `@symbol` mentions, plus automatic retrieval within a
  size budget. Pointer shows which files it chose and why.
- **Diff review:** every change is reviewed hunk by hunk. Nothing is written
  silently, and applied changes can be undone.
- **Streaming and cancellation:** tokens stream as they arrive. Stop at any
  time; a cancelled run leaves the workspace clean.

## Setup

Requirements: Node 22.14 or newer, VS Code 1.93 or newer, and Rust (stable) for
the retrieval engine.

**1. Start TrueForge locally.** `OUTBOUND_URL_ALLOWED_HOSTS` is an exclusive
allowlist. Include loopback, where Pointer's MCP servers run, and your model
provider's host.

```sh
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost","openrouter.ai"]' \
  npx @truefoundry/trueforge@latest --port 8790
```

**2. Register two model providers:** `pointer` for the primary model and
`pointer-backup` for the fallback. Give each its own endpoint or key, so that
when one breaks, the other still answers. Pointer tries `pointer/primary` first
and switches to `pointer-backup/primary` automatically. Fill in
[`agent/model-providers.example.json`](agent/model-providers.example.json) and
[`agent/model-providers.backup.example.json`](agent/model-providers.backup.example.json),
then register each:

```sh
curl -X PUT localhost:8790/api/v1/settings/model-providers \
  -H 'content-type: application/json' --data @my-provider.json
```

Any OpenAI-compatible endpoint works, as do TrueForge's built-in providers.
Keys stay in TrueForge and are never stored in this repo.

**3. Build Pointer.**

```sh
git clone https://github.com/pointersh/Pointer.git && cd Pointer
npm ci
npm run build
cargo build --release
```

**4. Run it.** Open the folder in VS Code and press F5. In the Extension
Development Host, open the repository you want to work on. On activation,
Pointer:
1. starts its editor MCP server and the retrieval engine;
2. registers both with TrueForge;
3. creates or updates the `pointer` agent from
   [`agent/pointer.agent.json`](agent/pointer.agent.json).

**Checks.** `npm run check:mcp` tests the editor MCP server.
`npm run check:trueforge` runs one full live turn (read, then an approved edit)
against your TrueForge.

| Setting | Default | |
|---|---|---|
| `pointer.trueforgeUrl` | `http://localhost:8790` | Where TrueForge runs |
| `pointer.models` | `["pointer/primary", "pointer-backup/primary"]` | Model chain, tried in order |
| `pointer.retrievalPath` | `target/release/pointer-retrieval` | Retrieval engine binary |
| `pointer.semanticSearch` | `false` | Add local jina code embeddings to retrieval. Downloads the model once (~630 MB) and builds in the background; the index lives in `.pointer/`, which ignores itself |

## Layout

```
src/                       VS Code extension (TypeScript)
  extension/               host side: inline edit, agent tools, review/undo, webview host
  webview/                 React agent panel
  common/                  shared types and the extension <-> webview protocol
agent/                     TrueForge agent definition + example model provider config
crates/pointer-retrieval/  Rust retrieval engine, served as an MCP server
benchmarks/                retrieval benchmark: Rust engine vs BM25 and grep
packages/highlight/        @pointersh/highlight: zero-dependency syntax highlighter (TS now, Rust/WASM later)
scaffold/                  upstream reference code kept only for ports (not built)
```

## Fork point

Pointer started from [pointersh/Pointer](https://github.com/pointersh/Pointer) (MIT) at
commit `48e5ee52e2c8690ff84680096625949c1fce55e3`.

What changed since then:
- removed the team gateway, P2P, tab completion, code review and i18n;
- moved the model and provider layer, embeddings and agent loop to `scaffold/`
  as reference material;
- replacing the agent loop with TrueForge.

The full delta is in the git history from the first commit.

## Contact

Built by **Ayush Yadav**.

- GitHub: [@ayuxy027](https://github.com/ayuxy027)
- X: [@ayuxy027](https://x.com/ayuxy027)
- LinkedIn: [ayushyadav27](https://www.linkedin.com/in/ayushyadav27/)
- Email: [ayush421301@gmail.com](mailto:ayush421301@gmail.com)
- Web: [thatayush.com](https://thatayush.com)

Bug reports and ideas: [open an issue](https://github.com/pointersh/Pointer/issues).

## License

MIT © 2026 Ayush Yadav. See [LICENSE](LICENSE).
