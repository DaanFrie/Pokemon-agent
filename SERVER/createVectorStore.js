import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAIEmbeddings, embeddingModel } from "./openaiEmbeddings.js";
import { savePokemonVectorStore } from "./vectorStore.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const documentsDirectory = path.join(currentDirectory, "documents");
const vectorStoreDirectory = path.join(currentDirectory, "vectorstore");

const requiredEnv = ["OPENAI_API_KEY"];

const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  throw new Error(`Ontbrekende instellingen in .env: ${missingEnv.join(", ")}`);
}

const fileNames = (await readdir(documentsDirectory))
  .filter((name) => name.endsWith(".txt"))
  .sort();

if (fileNames.length < 2) {
  throw new Error("Plaats minimaal twee .txt-documenten in SERVER/documents.");
}

const documents = await Promise.all(
  fileNames.map(async (fileName) => {
    const pageContent = await readFile(
      path.join(documentsDirectory, fileName),
      "utf8",
    );

    if (!pageContent.trim()) {
      throw new Error(`Document is leeg: ${fileName}`);
    }

    return new Document({
      pageContent,
      metadata: { source: fileName },
    });
  }),
);

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1200,
  chunkOverlap: 150,
});

const chunks = await splitter.splitDocuments(documents);
console.log(`${documents.length} documenten opgesplitst in ${chunks.length} chunks.`);

const embeddings = createOpenAIEmbeddings();
await savePokemonVectorStore(
  chunks,
  embeddings,
  vectorStoreDirectory,
  embeddingModel,
);

console.log(`Vectorstore opgeslagen in ${vectorStoreDirectory}`);