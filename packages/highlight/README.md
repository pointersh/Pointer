# @pointersh/highlight

A tiny, zero-dependency syntax highlighter.

- **Framework-agnostic core:** `tokenize(code, language)` returns `[kind, text]`
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

Status: TypeScript reference implementation. A Rust/WASM core is planned.
