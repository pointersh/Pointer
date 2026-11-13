import path from "path"
import Parser from "web-tree-sitter"

import { WASM_LANGUAGES } from "../common/constants"
import { assetPath } from "./context"

const parserCache: { [language: string]: Parser } = {}

let isInitialized = false

export const getParser = async (
  filePath: string
): Promise<Parser | undefined> => {
  try {
    if (!isInitialized) {
      await Parser.init()
      isInitialized = true
    }

    const fileExtension = path.extname(filePath).slice(1)
    const language = WASM_LANGUAGES[fileExtension]

    if (!language) return undefined

    if (parserCache[language]) {
      return parserCache[language]
    }

    const parser = new Parser()
    const wasmPath = assetPath(
      "out",
      "tree-sitter-wasms",
      `tree-sitter-${language}.wasm`
    )
    const parserLanguage = await Parser.Language.load(wasmPath)
    parser.setLanguage(parserLanguage)

    parserCache[language] = parser
    return parser
  } catch (e) {
    console.error("Error in getParser:", e)
    throw e
  }
}
