import { createRoot } from "react-dom/client"

import { Panel } from "./panel"

import "@pointersh/highlight/theme.css"
import "./styles/generated.css"

const container = document.querySelector("#root")

if (container) createRoot(container).render(<Panel />)
