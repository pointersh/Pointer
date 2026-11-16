import { tokenize } from "@pointersh/highlight"

import session from "./session.json"

interface Diff {
  file: string
  startLine: number
  original: string
  text: string
}

type Row = { kind: "same" | "del" | "add"; text: string; line?: number }

const editor = document.querySelector<HTMLElement>("#editor")!
const tabs = document.querySelector<HTMLElement>("#tabs")!
const panel = document.querySelector<HTMLIFrameElement>("#panel")!
const opened = new Map<string, Diff[]>()
let current: string | undefined

const language = (file: string) => file.split(".").pop() ?? "text"

const diffRows = (before: string[], after: string[]): Row[] => {
  const n = before.length
  const m = after.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const rows: Row[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      rows.push({ kind: "same", text: after[j] })
      i++
      j++
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      rows.push({ kind: "add", text: after[j++] })
    } else {
      rows.push({ kind: "del", text: before[i++] })
    }
  }
  return rows
}

const CONTEXT = 3

const hunks = (diff: Diff) => {
  const rows = diffRows(diff.original.split("\n"), diff.text.split("\n"))
  let line = diff.startLine + 1
  for (const row of rows) if (row.kind !== "del") row.line = line++
  const keep = rows.map((row, i) => rows.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((r) => r.kind !== "same"))
  const groups: Row[][] = []
  rows.forEach((row, i) => {
    if (!keep[i]) return
    if (!keep[i - 1] || !groups.length) groups.push([])
    groups[groups.length - 1].push(row)
  })
  return groups
}

const codeLine = (text: string, file: string) => {
  const span = document.createElement("span")
  span.className = "hl"
  for (const [kind, part] of tokenize(text, language(file))) {
    const token = document.createElement("span")
    if (kind !== "text") token.className = `hl-${kind}`
    token.textContent = part
    span.append(token)
  }
  return span
}

const renderHunk = (rows: Row[], file: string) => {
  const box = document.createElement("section")
  box.className = "hunk"
  const bar = document.createElement("div")
  bar.className = "hunk-bar"
  const added = rows.filter((r) => r.kind === "add").length
  const removed = rows.filter((r) => r.kind === "del").length
  const label = document.createElement("span")
  label.textContent = `Pointer proposed · +${added} −${removed}`
  const accept = document.createElement("button")
  accept.textContent = "Accept"
  accept.className = "primary"
  const reject = document.createElement("button")
  reject.textContent = "Reject"
  bar.append(label, accept, reject)
  const body = document.createElement("div")
  body.className = "lines"
  const draw = (keepKind: "add" | "del" | undefined) => {
    body.replaceChildren(
      ...rows
        .filter((row) => !keepKind || row.kind === "same" || row.kind === keepKind)
        .map((row) => {
          const line = document.createElement("div")
          line.className = `line ${keepKind ? "same" : row.kind}`
          const number = document.createElement("span")
          number.className = "gutter"
          number.textContent = row.line ? String(row.line) : ""
          line.append(number, codeLine(row.text, file))
          return line
        })
    )
  }
  draw(undefined)
  accept.onclick = () => {
    draw("add")
    bar.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Accepted · saved · ⌘Z to undo" }))
  }
  reject.onclick = () => {
    draw("del")
    bar.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Rejected · file unchanged" }))
  }
  box.append(bar, body)
  return box
}

const show = (file: string) => {
  current = file
  tabs.replaceChildren(
    ...[...opened.keys()].map((name) => {
      const tab = document.createElement("button")
      tab.className = name === file ? "tab active" : "tab"
      tab.textContent = name.split("/").pop() ?? name
      tab.title = name
      tab.onclick = () => show(name)
      return tab
    })
  )
  const header = document.createElement("div")
  header.className = "crumbs"
  header.textContent = file.split("/").join(" › ")
  editor.replaceChildren(header, ...(opened.get(file) ?? []).flatMap((diff) => hunks(diff).map((rows) => renderHunk(rows, file))))
}

const welcome = () => {
  opened.clear()
  current = undefined
  tabs.replaceChildren()
  const intro = document.createElement("div")
  intro.className = "welcome"
  const title = document.createElement("h1")
  title.textContent = "flask"
  const hint = document.createElement("p")
  hint.textContent = "Type anything in the Pointer panel to replay a multi-file task. Approve each step; proposed changes open here for review."
  const prompt = document.createElement("pre")
  prompt.textContent = session.prompt
  intro.append(title, hint, prompt)
  editor.replaceChildren(intro)
}

window.addEventListener("message", (event) => {
  const message = event.data as { type?: string; diffs?: Diff[] }
  if (message.type === "preview-diffs" && message.diffs) {
    for (const diff of message.diffs) opened.set(diff.file, [...(opened.get(diff.file) ?? []), diff])
    show(message.diffs[0].file)
  }
  if (message.type === "preview-reset") welcome()
})

document.querySelector<HTMLButtonElement>("#theme")!.onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light"
  document.documentElement.dataset.theme = next
  panel.src = `panel.html?theme=${next}`
  if (current) show(current)
  else welcome()
}

welcome()
