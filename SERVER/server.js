import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPokemonTools, loadIncludedPokemonNames } from "./tools.js";
import { callAgent, createPokemonAgent } from "./agent.js";
import { createOpenAIEmbeddings, embeddingModel } from "./openaiEmbeddings.js";
import { loadPokemonVectorStore } from "./vectorStore.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientDirectory = path.resolve(currentDirectory, "../CLIENT");
const vectorStoreDirectory = path.join(currentDirectory, "vectorstore");
const port = Number(process.env.PORT ?? 3001);

const requiredEnv = ["OPENAI_API_KEY", "OPENAI_MODEL"];
const gameSources = [
  ["black_2.txt", /\bblack\s*(?:2|two)\b|\bwhite\s*(?:2|two)\b/i],
  ["fire-red.txt", /\bfire\s*red\b|\bleaf\s*green\b/i],
  ["heartgold.txt", /\bheart\s*gold\b|\bsoul\s*silver\b/i],
  ["diamond.txt", /\bdiamond\b|\bpearl\b/i],
  ["platinum.txt", /\bplatinum\b/i],
  ["emerald.txt", /\bemerald\b/i],
  ["ruby.txt", /\bruby\b|\bsapphire\b/i],
  ["gold.txt", /\bgold\b|\bsilver\b|\bcrystal\b/i],
  ["red.txt", /\bred\s*(?:version|game)\b|\bpok[eé]mon\s+red\b/i],
  ["black.txt", /\bblack\b|\bwhite\b/i],
];
const knowledgeQuestionPattern =
  /\b(?:gym(?:s|leider)?|elite\s*four|elite\s*4|league|team(?:advies)?|matchup|type(?:s|effectiviteit)?|strategie)\b/i;

const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  throw new Error(`Ontbrekende instellingen in .env: ${missingEnv.join(", ")}`);
}

function auditToolResults(prompt, calls, messages, sources) {
  const normalize = (name) =>
    String(name ?? "").trim().toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ");
  const checks = calls.map((call) => {
    const message = messages.find(
      (item) => item.tool_call_id === call.id,
    );
    if (!message) {
      return { success: false, detail: `${call.name}: geen toolresultaat gevonden.` };
    }

    try {
      const result = JSON.parse(message.content);
      if (result?.error) {
        return { success: false, detail: `${call.name}: ${result.error}` };
      }

      if (call.name === "search_pokemon_knowledge") {
        const found = Array.isArray(result) && result.some(
          (item) =>
            item.source === call.args.source &&
            (call.args.source === "type_effectiveness.txt" ||
              item.retrieval === "embedding-similarity"),
        );
        return {
          success: found,
          detail: found
            ? `Embeddingzoektocht gebruikte ${call.args.source}.`
            : `Verwacht bestand of embeddingzoektocht ontbreekt voor ${call.args.source}.`,
        };
      }

      if (call.name === "lookup_pokemon_evolutions") {
        const expected = call.args.pokemon ?? [];
        const success =
          Array.isArray(result) &&
          result.length === expected.length &&
          expected.every((name) =>
            result.some((item) => normalize(item.pokemon) === normalize(name)),
          );
        return {
          success,
          detail: success
            ? "Evolutieresultaat ontvangen voor alle gevraagde Pokémon."
            : "Evolutieresultaten missen Pokémon of zijn ongeldig.",
        };
      }

      if (call.name === "analyze_pokemon_matchups") {
        const expected = call.args.pokemon ?? [];
        const opponents = call.args.opponents ?? [];
        const success =
          Array.isArray(result?.results) &&
          result.results.length === expected.length &&
          expected.every((name) => {
            const pokemon = result.results.find(
              (item) => normalize(item.pokemon) === normalize(name),
            );
            return (
              Array.isArray(pokemon?.matchups) &&
              opponents.every((opponent) =>
                pokemon.matchups.some(
                  (item) => normalize(item.opponent) === normalize(opponent),
                ),
              )
            );
          });
        return {
          success,
          detail: success
            ? "Matchupresultaat bevat alle kandidaten en tegenstanders."
            : "Matchupresultaten missen kandidaten of tegenstanders.",
        };
      }

      if (call.name === "lookup_pokemon_cards") {
        return {
          success: Array.isArray(result),
          detail: Array.isArray(result)
            ? "Kaartresultaat is een geldige lijst."
            : "Kaartresultaat heeft een ongeldige vorm.",
        };
      }

      return { success: false, detail: `Geen controle voor ${call.name}.` };
    } catch {
      return { success: false, detail: `${call.name}: ongeldig JSON-resultaat.` };
    }
  });

  const expectedSource = gameSources.find(([, pattern]) => pattern.test(prompt))?.[0];
  if (expectedSource || knowledgeQuestionPattern.test(prompt)) {
    const correctSource = expectedSource
      ? calls.some(
          (call) =>
            call.name === "search_pokemon_knowledge" &&
            call.args.source === expectedSource,
        ) && sources.includes(expectedSource)
      : calls.some((call) => call.name === "search_pokemon_knowledge");
    checks.push({
      success: correctSource,
      detail: expectedSource
        ? correctSource
          ? `Documentcontrole bevestigde ${expectedSource}.`
          : `Documentcontrole verwachtte ${expectedSource}.`
        : correctSource
          ? "Documentcontrole bevestigde gebruik van de kennis-tool."
          : "Documentcontrole: kennis-tool is niet gebruikt.",
    });
  }
  return checks;
}

const embeddings = createOpenAIEmbeddings();
const vectorStore = await loadPokemonVectorStore(
  vectorStoreDirectory,
  embeddings,
  embeddingModel,
);
const includedPokemonNames = await loadIncludedPokemonNames(
  path.join(currentDirectory, "documents"),
);
const tools = createPokemonTools(vectorStore, includedPokemonNames);
const agent = createPokemonAgent(tools, includedPokemonNames);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(clientDirectory));

app.post("/api/chat", async (req, res) => {
  const { prompt, sessionId } = req.body ?? {};

  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Vul eerst een vraag in." });
  }

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return res.status(400).json({ error: "Ongeldige chatsessie." });
  }

  try {
    const result = await callAgent(
      agent,
      prompt.trim(),
      sessionId,
      tools,
    );
    const toolChecks = auditToolResults(
      prompt.trim(),
      result.toolCalls,
      result.toolMessages,
      result.sources,
    );

    console.log("Agent tool-aanroepen:", result.toolCalls);
    console.log("Agent documentbronnen:", result.sources);
    console.log("Backend-controles:", toolChecks);
    if (toolChecks.some((check) => !check.success)) {
      console.error("Een of meer backend-controles zijn mislukt.");
    }

    return res.json({
      reply: result.reply,
      teamTitle: result.teamTitle,
      recommendations: result.recommendations,
      alternatives: result.alternatives,
      pokemonLists: result.pokemonLists,
    });
  } catch (error) {
    console.error("Fout tijdens agentaanroep:", error);
    return res.status(500).json({
      error: "De agent kon je vraag niet verwerken. Controleer de serverlog.",
    });
  }
});

app.listen(port, () => {
  console.log(`Pokémon-agent draait op http://localhost:${port}`);
});