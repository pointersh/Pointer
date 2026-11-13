import { useEffect, useState } from "react"

import { Theme } from "../../common/types"

import { useTheme } from "./useTheme"

const bodyTheme = (): "light" | "dark" | undefined => {
  const classes = document.body.classList
  if (classes.contains("vscode-light") || classes.contains("vscode-high-contrast-light")) return "light"
  if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) return "dark"
  return undefined
}

export const useCodeTheme = (): "light" | "dark" => {
  const reported = useTheme()
  const [fromBody, setFromBody] = useState(bodyTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => setFromBody(bodyTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return fromBody ?? (reported === Theme.Light ? "light" : "dark")
}
