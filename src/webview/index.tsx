import { createRoot } from "react-dom/client"

import { ErrorBoundary, Panel } from "./panel"

import "@pointersh/highlight/theme.css"
import "./styles/generated.css"

const container = document.querySelector("#root")

if (container) {
  createRoot(container).render(
    <ErrorBoundary label="the panel">
      <Panel />
    </ErrorBoundary>
  )
}
