import { spawn } from "node:child_process"
export async function rust(bin, root) {
  const t0 = performance.now()
  const p = spawn(bin, ["--root", root], { stdio: ["ignore", "pipe", "pipe"] })
  let err = ""; p.stderr.on("data", d => err += d)
  const line = await new Promise(r => p.stdout.on("data", d => { const m = String(d).match(/READY (\S+) (\S+)/); if (m) r(m) }))
  const ready = performance.now() - t0
  const [, url, token] = line
  let sid
  const rpc = async (method, params, id = 1) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })
    sid ??= res.headers.get("mcp-session-id")
    const text = await res.text()
    const data = text.split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))).find(x => x.id === id) ?? (text.startsWith("{") ? JSON.parse(text) : undefined)
    return data
  }
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bench", version: "0" } }, 0)
  await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })
  return { ready, err: () => err, kill: () => p.kill(), search: async (q) => (await rpc("tools/call", { name: "search_codebase", arguments: { query: q } }, 2)).result.content[0].text }
}
