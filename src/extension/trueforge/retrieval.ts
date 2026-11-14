import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"

import { logger } from "../../common/logger"

export interface RetrievalServer {
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

export const startRetrieval = (context: vscode.ExtensionContext, root: string): Promise<RetrievalServer | undefined> => {
  const binary = binaryPath(context)
  if (!fs.existsSync(binary)) {
    logger.warn(`pointer-retrieval not found at ${binary}; build it with \`cargo build --release\`. Falling back to the editor's search tools.`)
    return Promise.resolve(undefined)
  }
  const child = spawn(binary, ["--root", root], { stdio: ["ignore", "pipe", "pipe"] })
  child.stderr.on("data", (chunk) => logger.debug(`[retrieval] ${String(chunk).trimEnd()}`))
  return new Promise((resolve) => {
    let buffer = ""
    const timer = setTimeout(() => {
      logger.warn("pointer-retrieval did not become ready within 120 s")
      child.kill()
      resolve(undefined)
    }, 120_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve(undefined)
      if (code) logger.warn(`pointer-retrieval exited with code ${code}`)
    })
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk)
      const ready = /^READY (\S+) (\S+)$/m.exec(buffer)
      if (!ready) return
      clearTimeout(timer)
      resolve({ url: ready[1], token: ready[2], dispose: () => child.kill() })
    })
  })
}
