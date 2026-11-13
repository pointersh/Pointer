import table from "./strings.json"

const strings: Record<string, string> = table

type Vars = Record<string, unknown> & { count?: number }

export const t = (key: string, vars?: Vars): string => {
  const plural = vars?.count === undefined ? undefined : `${key}_${vars.count === 1 ? "one" : "other"}`
  const text = (plural && strings[plural]) ?? strings[key] ?? key
  return vars ? text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? "")) : text
}

export const useTranslation = () => ({ t })
