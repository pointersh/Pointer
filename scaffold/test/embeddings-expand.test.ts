import * as assert from "assert"

import {
  enclosingRange,
  importRange,
  SyntaxLike
} from "../../extension/embeddings/expand"

const node = (
  type: string,
  from: number,
  to: number,
  children: SyntaxLike[] = [],
  column?: number
): SyntaxLike => ({
  type,
  startPosition: { row: from },
  endPosition: { row: to, column },
  children
})

const lines = [
  "import a from \"a\"",
  "import b from \"b\"",
  "",
  "class C {",
  "  one() {",
  "    return 1",
  "  }",
  "  two() {",
  "    return 2",
  "  }",
  "}",
  "",
  "function f() { return 3 }"
]
const tree = node("program", 0, 13, [
  node("import_statement", 0, 0),
  node("import_statement", 1, 1),
  node("class_declaration", 3, 10, [
    node("class_body", 3, 10, [
      node("method_definition", 4, 6, [node("statement_block", 4, 6)]),
      node("method_definition", 7, 9, [node("statement_block", 7, 9)])
    ])
  ]),
  node("function_declaration", 12, 12)
], 0)

const chars = (from: number, to: number) =>
  lines.slice(from, to + 1).reduce((sum, line) => sum + line.length + 1, 0)

suite("Embeddings: widening hits", () => {
  test("a method grows to its class when the class fits", () => {
    assert.deepStrictEqual(enclosingRange(tree, lines, 5, 5, chars(3, 10)), [3, 10])
  })

  test("a method grows only to itself when the class is too big", () => {
    assert.deepStrictEqual(enclosingRange(tree, lines, 5, 5, chars(3, 10) - 1), [4, 6])
  })

  test("a hit in a small file grows to the whole file", () => {
    const range = enclosingRange(tree, lines, 5, 5, 10_000)
    assert.deepStrictEqual(range, [0, 12])
  })

  test("nothing grows when no enclosing node fits", () => {
    assert.strictEqual(enclosingRange(tree, lines, 4, 6, chars(4, 6)), undefined)
  })

  test("a hit spanning two methods grows to the class, not to one method", () => {
    assert.deepStrictEqual(enclosingRange(tree, lines, 6, 7, chars(3, 10)), [3, 10])
  })

  test("the import block is the run of imports at the top", () => {
    assert.deepStrictEqual(importRange(tree, lines, 1000), [0, 1])
  })

  test("imports past the budget, or absent, give nothing", () => {
    assert.strictEqual(importRange(tree, lines, 5), undefined)
    assert.strictEqual(importRange(node("program", 0, 1, [node("x", 0, 1)]), ["a", "b"], 1000), undefined)
  })

  test("a comment between imports does not end the block, code does", () => {
    const scattered = node("program", 0, 6, [
      node("import_statement", 0, 0),
      node("comment", 1, 1),
      node("import_statement", 2, 2),
      node("function_declaration", 3, 4),
      node("import_statement", 5, 5)
    ])
    const text = ["i", "//", "i", "f", "}", "i", ""]
    assert.deepStrictEqual(importRange(scattered, text, 1000), [0, 2])
  })
})
