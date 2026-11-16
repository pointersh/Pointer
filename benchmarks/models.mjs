const key = process.env.MAKORA_API_KEY
if (!key) {
  console.error("Set MAKORA_API_KEY for this command only, e.g.\n  MAKORA_API_KEY=mbh_... node benchmarks/models.mjs")
  process.exit(1)
}
const base = process.env.MODEL_BASE_URL ?? "https://inference.makora.com/v1"
const models = (process.env.MODELS ?? "zai-org/GLM-5.3-Flash,deepseek-ai/DeepSeek-V4.1-Flash").split(",")
const runs = Number(process.env.RUNS ?? 3)
const effort = Object.fromEntries((process.env.EFFORT ?? "").split(",").filter(Boolean).map((pair) => pair.split("=")))
const prompt = "Write a Python function that parses an ISO 8601 duration like P3DT4H5M into seconds, with a docstring and three doctests. Code only."

const once = async (model) => {
  const started = performance.now()
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: 2000, ...(effort[model] ? { reasoning_effort: effort[model] } : {}), messages: [{ role: "user", content: prompt }] })
  })
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`)
  let first
  let answer
  let chunks = 0
  let usage
  let buffer = ""
  for await (const part of res.body) {
    buffer += Buffer.from(part).toString("utf8")
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue
      const event = JSON.parse(line.slice(5))
      const delta = event.choices?.[0]?.delta
      const text = delta?.content || delta?.reasoning || delta?.reasoning_content
      if (text && first === undefined) first = performance.now()
      if (delta?.content && answer === undefined) answer = performance.now()
      if (text) chunks++
      if (event.usage) usage = event.usage
    }
  }
  const ended = performance.now()
  const tokens = usage?.completion_tokens ?? chunks
  const generating = (ended - (first ?? started)) / 1000
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0
  return { ttftMs: Math.round((first ?? ended) - started), answerMs: Math.round((answer ?? ended) - started), tokens, reasoning, tps: tokens / generating, totalS: (ended - started) / 1000, counted: usage ? "usage" : "chunks" }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const rows = {}
for (const model of models) {
  const results = []
  for (let i = 0; i < runs; i++) results.push(await once(model))
  rows[model] = {
    "first token (ms)": median(results.map((r) => r.ttftMs)),
    "tokens/s": median(results.map((r) => r.tps)).toFixed(1),
    "first answer token (ms)": median(results.map((r) => r.answerMs)),
    "output tokens": median(results.map((r) => r.tokens)),
    "of which reasoning": median(results.map((r) => r.reasoning)),
    "total (s)": median(results.map((r) => r.totalS)).toFixed(2),
    "reasoning effort": effort[model] ?? "default",
    "counted by": results[0].counted
  }
}
console.table(rows)
console.log(`median of ${runs} runs each · tokens/s = output tokens ÷ time from first token to last`)
