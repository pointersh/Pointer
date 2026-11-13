# scaffold/

Reference code from the pointer fork point, kept only to port from. It is not
built, linted or shipped (`tsconfig.json` excludes it).

| Path | Port target |
|---|---|
| `extension/embeddings/` (chunker, rank, search, expand, indexer) | `crates/pointer-retrieval` — chunking, ranking, hit expansion, incremental indexing |
| `extension/parser.ts` | tree-sitter setup for the Rust crate |
| `extension/chat-context.ts`, `budget.ts`, `git-context.ts`, `git.ts` | context assembly and budgeting strategy |
| `webview/providers/`, `common/provider-validation.ts` | the "Connect a model" screen (presets, form, validation) |
| `test/` | parity fixtures for the ports |

Delete each file once its port has landed.
