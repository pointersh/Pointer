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

```sh
git clone https://github.com/ayuxy027/Pointer.git
cd Pointer
npm ci
npm run build
```

Open the folder in VS Code and press F5 to launch the Extension Development Host.

TrueForge setup, agent definition and example model configuration: coming with
the TrueForge client.

## Layout

```
src/                       VS Code extension (TypeScript)
  extension/               host side: inline edit, agent tools, review/undo, webview host
  webview/                 React agent panel
  common/                  shared types and the extension <-> webview protocol
agent/                     TrueForge agent definition + example model provider config
crates/pointer-retrieval/  Rust retrieval engine, served as an MCP server
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

Bug reports and ideas: [open an issue](https://github.com/ayuxy027/Pointer/issues).

## License

MIT © 2026 Ayush Yadav. See [LICENSE](LICENSE).
