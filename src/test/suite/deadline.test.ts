import * as assert from "assert"

import { deadline } from "../../common/deadline"

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

suite("Deadline", () => {

  test("answered() stops the clock; the parent still cuts in until done()", async () => {
    const parent = new AbortController()
    const made = deadline(10, { parent: parent.signal })
    made.answered()
    await tick(30)
    assert.strictEqual(made.signal.aborted, false, "the clock stopped")
    parent.abort(new Error("stopped"))
    assert.strictEqual(made.signal.aborted, true, "the parent still counts")
    assert.strictEqual((made.signal.reason as Error).message, "stopped")

    const later = new AbortController()
    const finished = deadline(10, { parent: later.signal })
    finished.done()
    later.abort()
    await tick(30)
    assert.strictEqual(finished.signal.aborted, false, "after done() nothing reaches it")
  })

  test("a parent already aborted is forwarded at once, reason and all", () => {
    const parent = new AbortController()
    parent.abort(new Error("gone"))
    const made = deadline(1_000, { parent: parent.signal })
    assert.strictEqual(made.signal.aborted, true)
    assert.strictEqual((made.signal.reason as Error).message, "gone")
    made.done()
  })

})
