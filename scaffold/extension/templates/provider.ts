import * as Handlebars from "handlebars"

import { SYSTEM } from "../../common/constants"
import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"

import { defaultTemplates } from "./defaults"

const handlebars = Handlebars.create()
handlebars.registerHelper("eq", (a, b) => a == b)

const compiled = new Map(
  defaultTemplates.map(({ name, template }) => [name, handlebars.compile(template, { noEscape: true })])
)

export class TemplateProvider {
  public async readTemplate<T extends object>(templateName: string, data: T): Promise<string> {
    const template = compiled.get(templateName)
    if (!template) {
      logger.warn(`No template named "${templateName}"`)
      return ""
    }
    const own = templateName.endsWith(`-${SYSTEM}`) || templateName === SYSTEM ? undefined : compiled.get(`${templateName}-${SYSTEM}`)
    const system = own ?? compiled.get(SYSTEM)
    const context: Record<string, unknown> = { ...(data as Record<string, unknown>) }
    try {
      if (context.systemMessage == null) context.systemMessage = system ? system(context) : ""
      return template(context)
    } catch (error) {
      logger.error(`The template "${templateName}" did not render: ${messageOf(error)}`)
      return ""
    }
  }
}
