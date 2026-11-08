import { OpenAIEmbeddings } from "@langchain/openai";

export const embeddingModel =
  process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

export function createOpenAIEmbeddings() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY ontbreekt in .env.");
  }

  return new OpenAIEmbeddings({
    apiKey,
    model: embeddingModel,
  });
}
