import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"

import { logger } from "../../common/logger"

interface RetrievalServer {
  url: string
  token: string
  dispose(): void
}

const binaryPath = (context: vscode.ExtensionContext) => {
  const configured = vscode.workspace.getConfiguration("pointer").get<string>("retrievalPath")
  if (configured) return configured
  const name = process.platform === "win32" ? "pointer-retrieval.exe" : "pointer-retrieval"
  return path.join(context.extensionPath, "target", "release", name)
}

export const startRetrieval = (
  context: vscode.ExtensionContext,
  root: string,
  onExit: () => void
): Promise<RetrievalServer | undefined> => {
  const binary = binaryPath(context)
  if (!fs.existsSync(binary)) {
    logger.warn(`pointer-retrieval not found at ${binary}; build it with \`cargo build --release\`. Falling back to the editor's search tools.`)
    return Promise.resolve(undefined)
  }
  const semantic = vscode.workspace.getConfiguration("pointer").get<boolean>("semanticSearch", false)
  // stdin stays open while the extension host lives; the binary exits when it closes, so it never outlives VS Code.
  const child = spawn(binary, ["--root", root, "--exit-with-stdin", ...(semantic ? ["--semantic"] : [])], { stdio: ["pipe", "pipe", "pipe"] })
  child.stderr.on("data", (chunk) => logger.debug(`[retrieval] ${String(chunk).trimEnd()}`))
  return new Promise((resolve) => {
    let buffer = ""
    let ready = false
    const fail = (why: string) => {
      clearTimeout(timer)
      if (ready) {
        onExit()
        return
      }
      logger.warn(`pointer-retrieval ${why}`)
      resolve(undefined)
    }
    const timer = setTimeout(() => {
      child.kill()
      fail("did not become ready within 120 s")
    }, 120_000)
    child.on("error", (error) => fail(`could not start: ${error.message}`))
    child.on("exit", (code, signal) => fail(`exited (${signal ?? `code ${code}`})`))
    child.stdout.on("data", (chunk) => {
      if (ready) return
      buffer += String(chunk)
      const match = /^READY (\S+) (\S+)$/m.exec(buffer)
      if (!match) return
      ready = true
      buffer = ""
      clearTimeout(timer)
      resolve({ url: match[1], token: match[2], dispose: () => child.kill() })
    })
  })
}
