import * as fs from "fs"
import * as Handlebars from "handlebars"
import * as path from "path"

import { SYSTEM } from "../../common/constants"
import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"

import { defaultTemplates } from "./defaults"

const handlebars = Handlebars.create()
handlebars.registerHelper("eq", (a, b) => a == b)

const EXTENSION = ".hbs"

const compiled = new Map<string, HandlebarsTemplateDelegate>()
const MAX_COMPILED = 64

const compile = (source: string): HandlebarsTemplateDelegate => {
  let template = compiled.get(source)
  if (!template) {
    if (compiled.size >= MAX_COMPILED) compiled.clear()
    template = handlebars.compile(source, { noEscape: true })
    compiled.set(source, template)
  }
  return template
}

const builtIn = (name: string): string | undefined =>
  defaultTemplates.find((template) => template.name === name)?.template

const isSystemTemplate = (name: string) =>
  name === SYSTEM || name.endsWith(`-${SYSTEM}`)

const NON_INTERACTIVE = new Set(
  defaultTemplates
    .filter((template) => !template.interactive)
    .map((template) => template.name)
)

export class TemplateProvider {
  private readonly _basePath: string | undefined

  constructor(basePath: string | undefined) {
    this._basePath = basePath
  }

  public init() {
    if (!this._basePath) return
    try {
      fs.mkdirSync(this._basePath, { recursive: true })
    } catch (error) {
      logger.error(`Could not create the template folder ${this._basePath}: ${error}`)
      return
    }
    for (const { name, template } of defaultTemplates) {
      try {
        fs.writeFileSync(this.fileFor(name) as string, template, { encoding: "utf8", flag: "wx" })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          logger.warn(`Could not write the default template "${name}": ${error}`)
        }
      }
    }
  }

  public async readSystemMessageTemplate(templateName?: string): Promise<string> {
    const own =
      templateName && !isSystemTemplate(templateName)
        ? await this.readSource(`${templateName}-${SYSTEM}`)
        : undefined
    return own ?? (await this.readSource(SYSTEM)) ?? ""
  }

  public async readTemplate<T extends object>(
    templateName: string,
    data: T
  ): Promise<string> {
    const [source, systemMessage] = await Promise.all([
      this.readSource(templateName),
      this.readSystemMessageTemplate(templateName)
    ])
    if (source === undefined) {
      logger.warn(`No template named "${templateName}"`)
      return ""
    }

    const context: Record<string, unknown> = { ...(data as Record<string, unknown>) }
    if (context.systemMessage == null) context.systemMessage = systemMessage
    try {
      return compile(source)(context)
    } catch (error) {
      const fallback = builtIn(templateName)
      logger.error(
        `The template "${templateName}" did not render` +
          (fallback !== undefined && fallback !== source ? "; using the built-in one" : "") +
          `: ${messageOf(error)}`
      )
      if (fallback === undefined || fallback === source) return ""
      try {
        return compile(fallback)(context)
      } catch {
        return ""
      }
    }
  }

  public listTemplates(): string[] {
    if (!this._basePath) return []
    let files: string[]
    try {
      files = fs.readdirSync(this._basePath, "utf8")
    } catch {
      return []
    }
    return files
      .filter((file) => file.endsWith(EXTENSION))
      .map((file) => file.slice(0, -EXTENSION.length))
      .filter((name) => !NON_INTERACTIVE.has(name) && !isSystemTemplate(name))
      .sort((a, b) => a.localeCompare(b))
  }

  private fileFor(name: string): string | undefined {
    if (!this._basePath || !name || path.basename(name) !== name) return undefined
    return path.join(this._basePath, `${name}${EXTENSION}`)
  }

  private async readSource(name: string): Promise<string | undefined> {
    const file = this.fileFor(name)
    let text: string | undefined
    if (file) {
      try {
        text = await fs.promises.readFile(file, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn(`Could not read the template ${file}: ${error}`)
        }
      }
    }
    if (text?.trim()) return text
    return builtIn(name) ?? text
  }
}
