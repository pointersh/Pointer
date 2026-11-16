import type * as VsCode from "vscode"

import { SecretShield } from "./secret-shield"

const loadVsCode = (): typeof VsCode | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("vscode") as typeof VsCode
  } catch {
    return undefined
  }
}
const vscode = loadVsCode()

interface LogSink {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
  show(preserveFocus?: boolean): void
}

const headlessSink = (): LogSink => ({
  info: () => undefined,
  debug: () => undefined,
  warn: (message) => process.stderr.write(`[pointer] warn ${message}\n`),
  error: (message) => process.stderr.write(`[pointer] error ${message}\n`),
  show: () => undefined
})

const MAX_BLOCK_CHARS = 8000

const SECRET_KEY = /("?(?:api[_-]?key|authorization|token|secret|password)"?\s*[:=]\s*)("?)(?!Bearer\b)[^"\s,}&]+/gi
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g

export const redact = (text: string): string =>
  new SecretShield().redact(
    text
    .replace(BEARER, "Bearer ***")
    .replace(SECRET_KEY, (_, key: string, quote: string) => `${key}${quote}***`)
  )

const describe = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    const causeText = cause instanceof Error ? ` (${cause.message})` : ""
    return `${error.message}${causeText}`
  }
  return String(error)
}

const formatMs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`

const formatCount = (n: number): string =>
  n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const indent = (text: string, max = MAX_BLOCK_CHARS): string => {
  const cut =
    text.length > max
      ? `${text.slice(0, max)}\n… ${formatCount(text.length - max)} more characters`
      : text
  return cut
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

class Logger {
  private static instance: Logger
  private readonly channel: LogSink

  private constructor() {
    this.channel = vscode
      ? vscode.window.createOutputChannel("Pointer", { log: true })
      : headlessSink()
  }

  public static getInstance(): Logger {
    if (!Logger.instance) Logger.instance = new Logger()
    return Logger.instance
  }

  private get enabled() {
    if (!vscode) return false
    return vscode.workspace
      .getConfiguration("pointer")
      .get<boolean>("enableLogging", true)
  }

  public show() {
    this.channel.show(true)
  }

  public info(message: string) {
    if (this.enabled) this.channel.info(redact(message))
  }

  public warn(message: string) {
    this.channel.warn(redact(message))
  }

  public error(message: string | Error, error?: unknown) {
    const text =
      typeof message === "string"
        ? error === undefined
          ? message
          : `${message}: ${describe(error)}`
        : describe(message)
    this.channel.error(redact(text))
    if (vscode) console.error(`[pointer] ${redact(text)}`)
  }

  public debug(message: string) {
    if (this.enabled) this.channel.debug(redact(message))
  }

  public block(title: string, text: string) {
    if (!this.enabled || !text) return
    this.channel.debug(`${redact(title)}\n${indent(redact(text))}`)
  }

  public timer(): () => string {
    const started = Date.now()
    return () => formatMs(Date.now() - started)
  }
}

export const logger = Logger.getInstance()
