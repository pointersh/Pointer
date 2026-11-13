import React from "react"

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: "primary" | "secondary" | "icon" }

export const Button = ({ appearance = "primary", className, type = "button", ...rest }: Props) => (
  <button type={type} className={["btn", `btn-${appearance}`, className].filter(Boolean).join(" ")} {...rest} />
)
