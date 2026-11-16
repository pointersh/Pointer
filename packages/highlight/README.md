# @pointersh/highlight

A tiny, zero-dependency syntax highlighter.

- **Framework-agnostic core:** a Rust tokenizer compiled to WebAssembly; `tokenize(code, language)` returns `[kind, text]`
  tokens, and `highlight()` returns escaped HTML.
- **Optional React component:** `<Code code language startLine? />`.
- **Unopinionated theming:** every colour is a CSS variable (`--hl-keyword`,
  `--hl-string` and so on). The defaults follow the active VS Code theme when
  running inside a webview, with neutral fallbacks everywhere else.
- **Diff-aware:** `+`, `-` and `@@` lines get their own token kinds.

```ts
import { highlight } from "@pointersh/highlight"
import "@pointersh/highlight/theme.css"

el.innerHTML = `<pre class="hl"><code>${highlight(src, "python")}</code></pre>`
```

Token kinds: `comment`, `string`, `number`, `keyword`, `fn`, `tag`, `meta`,
`add`, `del` and `text`.

The tokenizer is Rust (`crates/pointer-highlight`) compiled to WebAssembly and
inlined into the bundle; `npm run build` builds it. `npm run check:highlight`
checks it against the original TypeScript tokenizer's output in `parity.json`.
