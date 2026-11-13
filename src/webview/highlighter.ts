import { PrismLight } from "react-syntax-highlighter"
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash"
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff"
import go from "react-syntax-highlighter/dist/esm/languages/prism/go"
import java from "react-syntax-highlighter/dist/esm/languages/prism/java"
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript"
import json from "react-syntax-highlighter/dist/esm/languages/prism/json"
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx"
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown"
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup"
import python from "react-syntax-highlighter/dist/esm/languages/prism/python"
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust"
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql"
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml"
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx"
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript"
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml"

import css from "react-syntax-highlighter/dist/esm/languages/prism/css"

const languages = {
  bash, css, diff, go, java, javascript, json, jsx, markdown, markup, python, rust, sql, toml, tsx, typescript, yaml,
  sh: bash, shell: bash, js: javascript, ts: typescript, py: python, rs: rust, html: markup, xml: markup, yml: yaml, md: markdown
}
for (const [name, grammar] of Object.entries(languages)) PrismLight.registerLanguage(name, grammar)

export { PrismLight as SyntaxHighlighter }
