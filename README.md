<p align="center"><img src="assets/icon.png" width="96" alt="Pointer"></p>

<h1 align="center">Pointer</h1>

<p align="center">The coding agent that finds the right code before it writes any.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <img src="https://img.shields.io/badge/VS_Code-1.93+-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code 1.93+">
  <img src="https://img.shields.io/badge/retrieval-Rust-CE422B?logo=rust&logoColor=white" alt="Rust retrieval">
  <img src="https://img.shields.io/badge/agent_loop-TrueForge-111" alt="TrueForge">
</p>

---

Pointer is a VS Code agent for repositories too large for any context window.
A Rust engine picks the code that matters and says why; the agent runs on
[TrueForge](https://github.com/truefoundry/trueforge); every change waits in
the editor for you to accept it, hunk by hunk.

## Features

- **[Points at the right code](docs/architecture.md#how-context-is-selected).**
  BM25, symbols, file names and a PageRank repo map, fused in Rust. Each hit
  shows its reason. [Ranks better than BM25 or grep](benchmarks/README.md),
  in 1.6 ms.
- **Inline edit.**
  Select, press <kbd>⌘I</kbd>, describe the change; the diff streams into the
  editor.
- **[Agent mode](docs/architecture.md#architecture-on-trueforge).** One request,
  several files, no need to say which.
- **Per-hunk review.** Nothing touches disk until you accept it, and
  <kbd>⌘Z</kbd> undoes it.
- **Stop at any time.** Cancelling leaves the workspace clean.
- **Two models, one switch.** If the primary model fails, the backup picks up
  the conversation.

## Quick start

```sh
npx @truefoundry/trueforge@latest --port 8790   # register a model provider first
git clone https://github.com/pointersh/Pointer.git && cd Pointer
npm ci && npm run build && cargo build --release
```

Open the folder in VS Code and press <kbd>F5</kbd>. Full steps:
**[docs/setup.md](docs/setup.md)**.

## Docs

- [Setup and settings](docs/setup.md)
- [How it works](docs/architecture.md)
- [Benchmarks](benchmarks/README.md)
- [`@pointersh/highlight`](crates/pointer-highlight/README.md), our Rust syntax highlighter

## Contact

[@ayuxy027 on X](https://x.com/ayuxy027)

## License

MIT © 2026 Ayush Yadav
