import {
commands,
DocumentSymbol, SymbolInformation,
SymbolKind,
Uri,
window,
workspace
} from "vscode"

import { ContextItem } from "../../common/types"

import { encodeSymbolRef } from "./symbol-ref"

const MAX_RESULTS = 30

const ATTACHABLE = new Set([
  SymbolKind.Class,
  SymbolKind.Constructor,
  SymbolKind.Enum,
  SymbolKind.Function,
  SymbolKind.Interface,
  SymbolKind.Method,
  SymbolKind.Module,
  SymbolKind.Namespace,
  SymbolKind.Struct,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Object,
  SymbolKind.Property,
  SymbolKind.TypeParameter
])

const toItem = (name: string, uri: Uri, line: number, kind: SymbolKind): ContextItem => {
  const relative = workspace.asRelativePath(uri, false)
  return {
    id: encodeSymbolRef({ path: relative, line, name }),
    category: "symbols",
    name,
    path: `${SymbolKind[kind].toLowerCase()} · ${relative}:${line + 1}`
  }
}

type AnySymbol = DocumentSymbol | SymbolInformation

const isDocumentSymbol = (symbol: AnySymbol): symbol is DocumentSymbol =>
  "children" in symbol && "range" in symbol

const flatten = (symbols: DocumentSymbol[], depth = 0): DocumentSymbol[] =>
  symbols.flatMap((symbol) => [
    symbol,
    ...(depth < 2 ? flatten(symbol.children || [], depth + 1) : [])
  ])

const allSymbols = async (uri: Uri): Promise<AnySymbol[]> => {
  const symbols =
    (await commands.executeCommand<AnySymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri
    )) || []
  const flat: AnySymbol[] = []
  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) flat.push(...flatten([symbol]))
    else flat.push(symbol)
  }
  return flat
}

const rangeOf = (symbol: AnySymbol) =>
  isDocumentSymbol(symbol) ? symbol.range : symbol.location.range

export const searchSymbols = async (query: string): Promise<ContextItem[]> => {
  const trimmed = query.trim()
  if (!trimmed) {
    const document = window.activeTextEditor?.document
    if (!document || document.uri.scheme !== "file") return []
    return (await allSymbols(document.uri))
      .filter((symbol) => ATTACHABLE.has(symbol.kind))
      .slice(0, MAX_RESULTS)
      .map((symbol) =>
        toItem(symbol.name, document.uri, rangeOf(symbol).start.line, symbol.kind)
      )
  }

  const results =
    (await commands.executeCommand<SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      trimmed
    )) || []
  return results
    .filter(
      (symbol) =>
        ATTACHABLE.has(symbol.kind) &&
        symbol.location.uri.scheme === "file" &&
        !/[\\/]node_modules[\\/]/.test(symbol.location.uri.fsPath)
    )
    .slice(0, MAX_RESULTS)
    .map((symbol) =>
      toItem(
        symbol.name,
        symbol.location.uri,
        symbol.location.range.start.line,
        symbol.kind
      )
    )
}
