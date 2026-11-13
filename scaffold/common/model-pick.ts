
export const EMBEDDING_MODEL_PATTERN = /embed|minilm|bge|e5|nomic/i

export const FIM_MODEL_PATTERN =
  /code|coder|fim|starcoder|codestral|codegemma|stable-code|qwen2\.5-coder|deepseek-coder/i

export const isEmbeddingModel = (name: string) =>
  EMBEDDING_MODEL_PATTERN.test(name)

export const isCodeModel = (name: string) =>
  FIM_MODEL_PATTERN.test(name) && !isEmbeddingModel(name)

const CHAT_HINT_PATTERN = /instruct|chat|it\b/i

const pickChatModel = (models: string[]): string | undefined => {
  const candidates = models.filter((m) => !isEmbeddingModel(m))
  return (
    candidates.find((m) => CHAT_HINT_PATTERN.test(m)) ||
    candidates.find((m) => !isCodeModel(m)) ||
    candidates[0]
  )
}

export const pickModel = (models: string[], type: string): string | undefined => {
  if (type === "embedding") {
    return models.find(isEmbeddingModel) || models[0]
  }
  if (type === "fim") {
    const nonEmbedding = models.filter((m) => !isEmbeddingModel(m))
    return nonEmbedding.find(isCodeModel) || nonEmbedding[0]
  }
  return pickChatModel(models) || models[0]
}

export const pickModelStrict = (
  models: string[],
  type: string
): string | undefined => {
  switch (type) {
    case "embedding":
      return models.find(isEmbeddingModel)
    case "fim":
      return models.find(isCodeModel)
    default:
      return pickChatModel(models)
  }
}
