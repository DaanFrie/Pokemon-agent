import { Document } from "@langchain/core/documents";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const vectorStoreFileName = "index.json";
const vectorStoreVersion = 1;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateVector(vector, dimensions, description) {
  if (
    !Array.isArray(vector) ||
    vector.length === 0 ||
    (dimensions !== undefined && vector.length !== dimensions) ||
    !vector.every(Number.isFinite)
  ) {
    throw new Error(`Ongeldige embedding in de vectorstore: ${description}.`);
  }
}

export async function savePokemonVectorStore(
  documents,
  embeddings,
  directory,
  model,
) {
  const vectors = await embeddings.embedDocuments(
    documents.map((document) => document.pageContent),
  );

  if (vectors.length !== documents.length) {
    throw new Error("Het aantal embeddings komt niet overeen met de documenten.");
  }

  const dimensions = vectors[0]?.length;
  if (!dimensions) {
    throw new Error("Er zijn geen geldige embeddings om op te slaan.");
  }

  const entries = documents.map((document, index) => {
    const vector = vectors[index];
    validateVector(vector, dimensions, `document ${index + 1}`);
    return {
      pageContent: document.pageContent,
      metadata: document.metadata,
      vector,
    };
  });

  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, vectorStoreFileName),
    JSON.stringify({ version: vectorStoreVersion, model, entries }),
    "utf8",
  );
}

export async function loadPokemonVectorStore(
  directory,
  embeddings,
  model,
) {
  const file = await readFile(path.join(directory, vectorStoreFileName), "utf8");
  const stored = JSON.parse(file);

  if (
    !isRecord(stored) ||
    stored.version !== vectorStoreVersion ||
    stored.model !== model ||
    !Array.isArray(stored.entries) ||
    stored.entries.length === 0
  ) {
    throw new Error(
      "De vectorstore ontbreekt, is ongeldig of gebruikt een ander embeddingmodel. Voer npm run create-vectorstore opnieuw uit.",
    );
  }

  const firstEntry = stored.entries[0];
  if (!isRecord(firstEntry) || !Array.isArray(firstEntry.vector)) {
    throw new Error("De vectorstore bevat een ongeldig document.");
  }

  const dimensions = firstEntry.vector.length;
  const entries = stored.entries.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.pageContent !== "string" ||
      !isRecord(entry.metadata) ||
      typeof entry.metadata.source !== "string"
    ) {
      throw new Error(`Ongeldig document in de vectorstore: ${index + 1}.`);
    }

    validateVector(entry.vector, dimensions, `document ${index + 1}`);
    return entry;
  });

  return {
    getSourceDocuments(source) {
      const documents = entries
        .filter((entry) => entry.metadata.source === source)
        .map(
          (entry) =>
            new Document({
              pageContent: entry.pageContent,
              metadata: entry.metadata,
            }),
        );

      if (documents.length === 0) {
        throw new Error(`De vectorstore bevat geen documenten voor ${source}.`);
      }

      return documents;
    },
    async similaritySearch(query, k = 4, source) {
      if (!Number.isInteger(k) || k < 0) {
        throw new Error("Het aantal zoekresultaten moet een niet-negatief geheel getal zijn.");
      }
      if (k === 0) {
        return [];
      }

      const candidateEntries = source
        ? entries.filter((entry) => entry.metadata.source === source)
        : entries;
      if (source && candidateEntries.length === 0) {
        throw new Error(`De vectorstore bevat geen documenten voor ${source}.`);
      }

      const queryVector = await embeddings.embedQuery(query);
      validateVector(queryVector, dimensions, "zoekopdracht");
      const queryMagnitude = Math.sqrt(
        queryVector.reduce((sum, value) => sum + value * value, 0),
      );

      if (queryMagnitude === 0) {
        throw new Error("De embedding van de zoekopdracht heeft geen lengte.");
      }

      return candidateEntries
        .map((entry, index) => {
          const dotProduct = entry.vector.reduce(
            (sum, value, vectorIndex) =>
              sum + value * queryVector[vectorIndex],
            0,
          );
          const documentMagnitude = Math.sqrt(
            entry.vector.reduce((sum, value) => sum + value * value, 0),
          );
          const score =
            documentMagnitude === 0
              ? 0
              : dotProduct / (documentMagnitude * queryMagnitude);

          return { entry, index, score };
        })
        .sort(
          (left, right) =>
            right.score - left.score || left.index - right.index,
        )
        .slice(0, k)
        .map(
          ({ entry }) =>
            new Document({
              pageContent: entry.pageContent,
              metadata: entry.metadata,
            }),
        );
    },
  };
}
