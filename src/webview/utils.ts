export const getThinkingMessage = (content: string): { thinking: string | null; message: string } => {
  const blocks = [...content.matchAll(/<(?:think|thinking)>([\s\S]*?)(?:<\/(?:think|thinking)>|$)/g)]
  if (!blocks.length) return { thinking: null, message: content }
  const thinking = blocks.map((block) => block[1].trim()).filter(Boolean).join("\n\n")
  const message = content.replace(/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/g, "").trim()
  return { thinking, message }
}
