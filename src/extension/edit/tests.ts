import * as path from "path"

import { SYSTEM, USER } from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"

export interface TestRequest {
  code: string
  language?: string
  fileName: string
  testFileName: string
  framework?: string
  existing?: string
}

export const testFileName = (
  name: string,
  ext: string,
  languageId: string
): string => {
  switch (languageId) {
    case "python":
      return `test_${name}${ext}`
    case "go":
    case "rust":
      return `${name}_test${ext}`
    case "ruby":
      return `${name}_spec${ext}`
    case "java":
    case "kotlin":
    case "scala":
    case "csharp":
    case "php":
      return `${name}Test${ext}`
    default:
      return `${name}.test${ext}`
  }
}

export const testFilePath = (sourcePath: string, languageId: string): string => {
  const { dir, name, ext } = path.parse(sourcePath)
  return path.join(dir, testFileName(name, ext, languageId))
}

export const isTestFile = (filePath: string): boolean => {
  const base = path.basename(filePath)
  return (
    /\.(test|spec)\.[^.]+$/i.test(base) ||
    /_(test|spec)\.[^.]+$/i.test(base) ||
    /^test_.*\.py$/i.test(base) ||
    /Tests?\.(java|kt|scala|cs|php)$/.test(base)
  )
}

const JS_LANGUAGES = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact"
])

export const testFrameworkFor = (
  languageId: string,
  dependencies: string[] = []
): string | undefined => {
  const has = (name: string) => dependencies.includes(name)
  if (JS_LANGUAGES.has(languageId)) {
    if (has("vitest")) return "vitest"
    if (has("jest") || has("ts-jest") || has("@jest/globals")) return "jest"
    if (has("mocha")) return "mocha with node's assert module"
    if (has("ava")) return "ava"
    if (has("jasmine")) return "jasmine"
    return undefined
  }
  switch (languageId) {
    case "python":
      return "pytest"
    case "go":
      return "the standard testing package"
    case "rust":
      return "the built-in #[test] attribute"
    case "ruby":
      return "RSpec"
    case "java":
    case "kotlin":
    case "scala":
      return "JUnit 5"
    case "csharp":
      return "xUnit"
    case "php":
      return "PHPUnit"
    default:
      return undefined
  }
}

export const TEST_SYSTEM_PROMPT = [
  "You are an expert programmer writing unit tests inside the user's editor.",
  "You will be given source code and the name of the test file the tests go in.",
  "",
  "Rules:",
  "- Reply with the test code only. No explanation, no commentary, no markdown fences.",
  "- Write complete, runnable tests: include the imports and setup they need.",
  "- The test file sits in the same directory as the source file; import the code under test from there.",
  "- Cover the normal cases, the edge cases and the error cases of what the code does.",
  "- Do not modify or restate the source code; test it as it is."
].join("\n")

const fence = (language: string | undefined, body: string) =>
  `\`\`\`${language || ""}\n${body}\n\`\`\``

export const buildTestPrompt = (request: TestRequest): string => {
  const parts: string[] = []
  parts.push(`Source file: ${request.fileName}`)
  parts.push(fence(request.language, request.code))

  let where = `Test file: ${request.testFileName}`
  if (request.language && JS_LANGUAGES.has(request.language)) {
    const { name } = path.parse(request.fileName)
    where += ` (import the code under test from "./${name}")`
  }
  parts.push(where)

  if (request.framework) {
    parts.push(`Framework: ${request.framework}.`)
  } else {
    parts.push(
      `Framework: the most popular testing library for ${
        request.language || "this language"
      }.`
    )
  }

  if (request.existing?.trim()) {
    parts.push("The test file already exists with this content:")
    parts.push(fence(request.language, request.existing))
    parts.push(
      "Reply with the new tests to add at the end of it only; do not repeat the imports or the tests already there."
    )
  }

  parts.push("Reply with the test code only.")
  return parts.join("\n\n")
}

export const buildTestMessages = (
  request: TestRequest
): ChatCompletionMessage[] => [
  { role: SYSTEM, content: TEST_SYSTEM_PROMPT },
  { role: USER, content: buildTestPrompt(request) }
]

export const appendTests = (
  lastLine: string,
  fileIsEmpty: boolean,
  code: string
): string => {
  if (!code) return lastLine
  if (fileIsEmpty) return code
  return lastLine ? `${lastLine}\n\n${code}` : `\n${code}`
}

export const declaredDependencies = (packageJson: string): string[] => {
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>
    const names: string[] = []
    for (const key of ["dependencies", "devDependencies"]) {
      const section = parsed[key]
      if (section && typeof section === "object") {
        names.push(...Object.keys(section as Record<string, unknown>))
      }
    }
    return names
  } catch {
    return []
  }
}
