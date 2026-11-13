export interface DefaultTemplate {
  name: string
  template: string
}

export const defaultTemplates: DefaultTemplate[] = [
  {
    name: "system",
    template: `You are a helpful, respectful and honest coding assistant.
Always reply using markdown.
Be clear and concise, prioritizing brevity in your responses.
For code refactoring, use markdown with appropriate code formatting.`.trim()
  },
  {
    name: "relevant-code",
    template: `
Code from the workspace that may be relevant. Each block is labelled with its file and line range; refer to those when you answer. Ignore any block that does not bear on the question.

{{{code}}}`.trim()
  }
]
