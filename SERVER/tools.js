import { tool } from "langchain";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

const knowledgeSources = [
  "black.txt",
  "black_2.txt",
  "diamond.txt",
  "emerald.txt",
  "fire-red.txt",
  "gold.txt",
  "heartgold.txt",
  "platinum.txt",
  "red.txt",
  "ruby.txt",
];
const generalInfoSource = "general_info.txt";
const typeEffectivenessSource = "type_effectiveness.txt";
const searchableSources = [...knowledgeSources, typeEffectivenessSource];

function normalizePokemonName(name) {
  return name.trim().toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ");
}

async function findUnsupportedPokemon(names, includedPokemonNames) {
  const checks = await Promise.all(
    names.map(async (name) => ({
      name,
      included: await isIncludedPokemonOrEvolution(name, includedPokemonNames),
    })),
  );
  return checks.filter(({ included }) => !included).map(({ name }) => name);
}

const pokemonDataCache = new Map();
const evolutionFamilyCache = new Map();

export async function loadIncludedPokemonNames(documentsDirectory) {
  const names = new Set();

  for (const source of knowledgeSources) {
    const text = await readFile(path.join(documentsDirectory, source), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const tier = line.match(/^\s*(?:S\+?|[A-D])[- ]Tier\b[^:]*:\s*(.+?)\s*$/i);
      if (tier) {
        for (const name of tier[1].split(",")) {
          const cleanedName = name.trim();
          if (cleanedName && !/-forms$/i.test(cleanedName)) {
            names.add(cleanedName);
          }
        }
      }

      for (const match of line.matchAll(/\(Lv\.?\s*\d+\)/g)) {
        const commaIndex = line.lastIndexOf(",", match.index);
        const separatorIndex = line.lastIndexOf(" - ", match.index);
        const startIndex =
          separatorIndex > commaIndex ? separatorIndex + 3 : commaIndex + 1;
        const name = line.slice(startIndex, match.index).trim();
        if (name) {
          names.add(name);
        }
      }
    }
  }

  if (names.size === 0) {
    throw new Error("Er zijn geen Pokémon gevonden in de game-documenten.");
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

async function fetchPokemonDataUncached(name) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, "-");
  const speciesResponse = await fetch(
    `https://pokeapi.co/api/v2/pokemon-species/${encodeURIComponent(slug)}`,
  );
  if (!speciesResponse.ok) {
    throw new Error(
      `PokéAPI kon de soortgegevens van ${name} niet ophalen: status ${speciesResponse.status}.`,
    );
  }

  const species = await speciesResponse.json();
  let pokemonResponse = await fetch(
    `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(slug)}`,
  );
  if (pokemonResponse.status === 404) {
    pokemonResponse = await fetch(
      `https://pokeapi.co/api/v2/pokemon/${species.id}`,
    );
  }
  if (!pokemonResponse.ok) {
    throw new Error(
      `PokéAPI kon typegegevens van ${name} niet ophalen: status ${pokemonResponse.status}.`,
    );
  }
  const pokemonData = await pokemonResponse.json();
  const chainUrl = species.evolution_chain?.url;
  if (typeof chainUrl !== "string") {
    throw new Error(`PokéAPI heeft geen evolutieketen voor ${name} teruggegeven.`);
  }

  const chainResponse = await fetch(chainUrl);
  if (!chainResponse.ok) {
    throw new Error(
      `PokéAPI kon de evolutieketen van ${name} niet ophalen: status ${chainResponse.status}.`,
    );
  }
  const chainData = await chainResponse.json();

  return {
    pokemon: species.name,
    types: pokemonData.types.map(({ type }) => type.name),
    pastTypes: (pokemonData.past_types ?? []).map((entry) => ({
      generation: generationNumber(entry.generation.name),
      types: entry.types
        .sort((left, right) => left.slot - right.slot)
        .map(({ type }) => type.name),
    })),
    evolutionChain: serializeEvolutionChain(chainData.chain),
  };
}

async function fetchPokemonData(name) {
  const key = normalizePokemonName(name);
  if (!pokemonDataCache.has(key)) {
    const request = fetchPokemonDataUncached(name).catch((error) => {
      pokemonDataCache.delete(key);
      throw error;
    });
    pokemonDataCache.set(key, request);
  }
  return pokemonDataCache.get(key);
}

function getEvolutionFamilyNames(node) {
  return [
    node.name,
    ...(node.evolvesTo ?? []).flatMap(getEvolutionFamilyNames),
  ];
}

export async function isIncludedPokemonOrEvolution(name, includedPokemonNames) {
  const includedPokemon = new Set(
    includedPokemonNames.map(normalizePokemonName),
  );
  if (includedPokemon.has(normalizePokemonName(name))) {
    return true;
  }

  const key = normalizePokemonName(name);
  if (!evolutionFamilyCache.has(key)) {
    const request = fetchPokemonData(name)
      .then(({ evolutionChain }) =>
        new Set(getEvolutionFamilyNames(evolutionChain).map(normalizePokemonName)),
      )
      .catch((error) => {
        if (/soortgegevens .* status 404\./i.test(error.message)) {
          return new Set();
        }
        evolutionFamilyCache.delete(key);
        throw error;
      });
    evolutionFamilyCache.set(key, request);
  }

  const family = await evolutionFamilyCache.get(key);
  return [...family].some((familyName) => includedPokemon.has(familyName));
}

function generationNumber(name) {
  const roman = name.replace("generation-", "").toLowerCase();
  const values = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9 };
  return values[roman];
}

function getPokemonTypesForGeneration(pokemon, generation) {
  const pastTypes = [...pokemon.pastTypes]
    .filter((entry) => entry.generation >= generation)
    .sort((left, right) => left.generation - right.generation);
  return pastTypes[0]?.types ?? pokemon.types;
}

function serializeEvolutionChain(node, evolvesBy = null) {
  return {
    name: node.species.name,
    evolvesBy,
    evolvesTo: (node.evolves_to ?? []).map((evolution) =>
      serializeEvolutionChain(
        evolution,
        getEvolutionDetails(evolution.evolution_details?.[0]),
      ),
    ),
  };
}

function getEvolutionDetails(details = {}) {
  return {
    trigger: details.trigger?.name ?? null,
    minimumLevel: details.min_level ?? null,
    item: details.item?.name ?? null,
    timeOfDay: details.time_of_day || null,
    minimumHappiness: details.min_happiness ?? null,
    location: details.location?.name ?? null,
    knownMove: details.known_move?.name ?? null,
  };
}

function getLevelReachablePaths(chain, levelCap) {
  function walk(node, path) {
    const currentPath = [...path, node.name];
    const paths = [currentPath];

    for (const evolution of node.evolvesTo ?? []) {
      const details = evolution.evolvesBy;
      if (
        details.trigger === "level-up" &&
        Number.isInteger(details.minimumLevel) &&
        details.minimumLevel <= levelCap
      ) {
        paths.push(...walk(evolution, currentPath));
      }
    }

    return paths;
  }

  return walk(chain, []);
}

export function parseTypeChart(documents, generation) {
  const chart = new Map();
  let multiplier = null;

  for (const line of documents.map((document) => document.pageContent).join("\n").split(/\r?\n/)) {
    if (/SUPER EFFECTIEF/i.test(line)) {
      multiplier = 2;
      continue;
    }
    if (/NIET ERG EFFECTIEF/i.test(line)) {
      multiplier = 0.5;
      continue;
    }
    if (/GEEN EFFECT/i.test(line)) {
      multiplier = 0;
      continue;
    }

    const matchup = line.match(/^\s*-\s*([\w-]+)\s*:\s*(.+)\.\s*$/);
    if (multiplier !== null && matchup && !/geen\.?$/i.test(matchup[2])) {
      const attacker = matchup[1].toLowerCase();
      const defenders = matchup[2]
        .split(",")
        .map((type) => type.trim().toLowerCase());
      for (const defender of defenders) {
        chart.set(`${attacker}:${defender}`, multiplier);
      }
      continue;
    }

    const immunity = line.match(/^\s*-\s*([\w-]+)\s*->\s*([\w-]+)\./);
    if (multiplier === 0 && immunity) {
      chart.set(
        `${immunity[1].toLowerCase()}:${immunity[2].toLowerCase()}`,
        0,
      );
    }
  }

  if (generation === 1) {
    chart.delete("ice:fire");
    chart.set("poison:bug", 2);
    chart.set("ghost:psychic", 0);
    for (const key of [...chart.keys()]) {
      const [attackType, defendType] = key.split(":");
      if (["dark", "steel", "fairy"].includes(attackType) ||
        ["dark", "steel", "fairy"].includes(defendType)) {
        chart.delete(key);
      }
    }
  } else {
    for (const key of [...chart.keys()]) {
      const [attackType, defendType] = key.split(":");
      if (attackType === "fairy" || defendType === "fairy") {
        chart.delete(key);
      }
    }
  }

  return chart;
}

export function createPokemonTools(vectorStore, includedPokemonNames) {
  const unsupportedPokemonMessage =
    "Ik kan alleen informatie geven over Pokémon uit de meegeleverde game-documenten en hun evolutielijnen.";

  const searchPokemonKnowledge = tool(
    async ({ query, source }) => {
      console.log(`[tool] search_pokemon_knowledge (${source}): ${query}`);

      const isEliteFourQuestion = /\belite\s*(?:four|4)\b/i.test(query);
      const [similarGameKnowledge, generalInfo, typeEffectiveness] = await Promise.all([
        source === typeEffectivenessSource
          ? []
          : vectorStore.similaritySearch(query, 8, source),
        Promise.resolve(vectorStore.getSourceDocuments(generalInfoSource)),
        Promise.resolve(vectorStore.getSourceDocuments(typeEffectivenessSource)),
      ]);
      const eliteFourKnowledge =
        isEliteFourQuestion && source !== typeEffectivenessSource
          ? vectorStore
              .getSourceDocuments(source)
              .filter((document) => /\belite\s*(?:four|4)\s*:/i.test(document.pageContent))
          : [];
      const gameKnowledge = [
        ...new Map(
          [...similarGameKnowledge, ...eliteFourKnowledge].map((document) => [
            document.pageContent,
            document,
          ]),
        ).values(),
      ];

      const sources = [...generalInfo, ...typeEffectiveness, ...gameKnowledge].map(
        (document) => ({
          source: document.metadata.source,
          excerpt: document.pageContent,
          retrieval:
            document.metadata.source === source &&
            source !== typeEffectivenessSource
              ? "embedding-similarity"
              : "reference",
        }),
      );

      console.log(
        "[tool] gevonden bronnen:",
        sources.map((item) => item.source),
      );

      return JSON.stringify(sources);
    },
    {
      name: "search_pokemon_knowledge",
      description: `Zoek met embedding similarity de acht relevantste chunks in precies één gekozen Pokémon-gamebestand; bij een vraag over de Elite Four voeg je ook altijd de chunk met de volledige Elite Four-roster toe. Bij een algemene typevraag zonder genoemde game mag type_effectiveness.txt als source worden gekozen. De volledige algemene richtlijnen uit general_info.txt en typechart uit type_effectiveness.txt worden altijd automatisch toegevoegd en moeten bij team-, gym- en typeadvies worden toegepast. Gamebestanden: ${knowledgeSources.join(", ")}. Gebruik nooit een ander gamebestand als bron.`,
      schema: z.object({
        query: z.string().describe("De vraag of informatie die je wilt opzoeken"),
        source: z.enum(searchableSources).describe(
          "Exacte bestandsnaam van het genoemde gamebestand; gebruik type_effectiveness.txt alleen voor een algemene typevraag zonder genoemde game",
        ),
      }),
    },
  );

  const lookupPokemonEvolutions = tool(
    async ({ pokemon, levelCap, generation }) => {
      const unsupported = await findUnsupportedPokemon(
        pokemon,
        includedPokemonNames,
      );
      if (unsupported.length > 0) {
        return JSON.stringify({
          error: `${unsupportedPokemonMessage} Niet herkend: ${unsupported.join(", ")}.`,
        });
      }

      console.log(
        `[tool] lookup_pokemon_evolutions (level cap ${levelCap}): ${pokemon.join(", ")}`,
      );
      const results = await Promise.all(
        pokemon.map(async (name) => {
          const data = await fetchPokemonData(name);
          return {
            pokemon: data.pokemon,
            types: getPokemonTypesForGeneration(data, generation),
            evolutionChain: data.evolutionChain,
            possibleEvolutionPathsAtLevelCap: getLevelReachablePaths(
              data.evolutionChain,
              levelCap,
            ),
          };
        }),
      );
      return JSON.stringify(results);
    },
    {
      name: "lookup_pokemon_evolutions",
      description:
        "Verplicht gebruiken voor teamadvies en voor advies over evoluties. Geef de huidige teamleden en serieuze kandidaat-Pokémon, de generation van de gekozen game en levelCap passend bij het doel van de vraag: hoogste level van de eerstvolgende gym voor kortetermijnadvies, of hoogste level van de Elite Four/Champion voor advies tot het einde van de game. Deze tool retourneert de volledige evolutieketen en level-evolutiepaden die uiterlijk op levelCap haalbaar zijn. Kies voor het doel de verste vorm in een geldig pad; adviseer geen eerdere vorm als die vóór het doel verder kan evolueren.",
      schema: z.object({
        pokemon: z
          .array(z.string())
          .min(1)
          .max(6)
          .describe("De Pokémon waarvoor je de evolutieketen wilt controleren"),
        levelCap: z
          .number()
          .int()
          .positive()
          .describe("Hoogste level van het gevecht dat het doel van het advies bepaalt"),
        generation: z.number().int().min(1).max(5),
      }),
    },
  );

  const analyzePokemonMatchups = tool(
    async ({ pokemon, opponents, generation }) => {
      const unsupported = await findUnsupportedPokemon(
        [...new Set([...pokemon, ...opponents])],
        includedPokemonNames,
      );
      if (unsupported.length > 0) {
        return JSON.stringify({
          error: `${unsupportedPokemonMessage} Niet herkend: ${unsupported.join(", ")}.`,
        });
      }

      const typeChart = parseTypeChart(
        vectorStore.getSourceDocuments(typeEffectivenessSource),
        generation,
      );
      const pokemonData = new Map();
      const getPokemon = async (name) => {
        if (!pokemonData.has(name)) {
          pokemonData.set(name, fetchPokemonData(name));
        }
        return pokemonData.get(name);
      };
      const opponentData = await Promise.all(
        opponents.map(async (name) => {
          const data = await getPokemon(name);
          return {
            pokemon: data.pokemon,
            types: getPokemonTypesForGeneration(data, generation),
          };
        }),
      );
      const results = await Promise.all(
        pokemon.map(async (name) => {
          const data = await getPokemon(name);
          const types = getPokemonTypesForGeneration(data, generation);
          const matchups = opponentData.map((opponent) => {
            const stabMultipliers = types.map((attackType) => ({
              attackType,
              multiplier: Number(
                opponent.types.reduce(
                  (combined, defendingType) =>
                    combined *
                    (typeChart.get(`${attackType}:${defendingType}`) ?? 1),
                  1,
                ).toFixed(2),
              ),
            }));
            return {
              opponent: opponent.pokemon,
              opponentTypes: opponent.types,
              stabMultipliers,
              bestStabMultiplier: Math.max(
                ...stabMultipliers.map(({ multiplier }) => multiplier),
              ),
            };
          });

          return {
            pokemon: data.pokemon,
            types,
            matchups,
            superEffectiveAgainst: matchups
              .filter(({ bestStabMultiplier }) => bestStabMultiplier > 1)
              .map(({ opponent }) => opponent),
          };
        }),
      );

      return JSON.stringify({ generation, results });
    },
    {
      name: "analyze_pokemon_matchups",
      description:
        "Verplicht gebruiken voor gym/teamadvies. Geef kandidaat-Pokémon, de exacte namen van de tegenstanders uit de relevante roster (niet alleen het algemene gymtype) en generation 1-5 op. Berekent per kandidaat en per tegenstander alle eigen STAB-multipliers tegen de volledige verdedigingstypen. Alleen multiplier >1 is super effectief; gebruik superEffectiveAgainst om kandidaten te selecteren.",
      schema: z.object({
        pokemon: z.array(z.string()).min(1).max(6),
        opponents: z.array(z.string()).min(1).max(6),
        generation: z.number().int().min(1).max(5),
      }),
    },
  );

  const lookupPokemonCards = tool(
    async ({ name }) => {
      if (
        !(await isIncludedPokemonOrEvolution(name, includedPokemonNames))
      ) {
        return unsupportedPokemonMessage;
      }

      const apiKey = process.env.POKEMON_TCG_API_KEY;
      if (!apiKey) {
        throw new Error("POKEMON_TCG_API_KEY ontbreekt in .env.");
      }

      console.log(`[tool] lookup_pokemon_cards: ${name}`);

      const query = encodeURIComponent(`name:${name}`);
      const response = await fetch(
        `https://api.pokemontcg.io/v2/cards?q=${query}&pageSize=3`,
        { headers: { "X-Api-Key": apiKey } },
      );

      if (!response.ok) {
        throw new Error(
          `Pokémon TCG API gaf status ${response.status} terug.`,
        );
      }

      const result = await response.json();

      return JSON.stringify(
        result.data.map((card) => ({
          name: card.name,
          set: card.set?.name,
          number: card.number,
          image: card.images?.small,
        })),
      );
    },
    {
      name: "lookup_pokemon_cards",
      description:
        "Zoek Pokémon-kaarten op naam via de Pokémon TCG API. Gebruik dit wanneer de gebruiker vraagt naar Pokémon-kaarten.",
      schema: z.object({
        name: z.string().describe("De naam van de Pokémon"),
      }),
    },
  );

  return [
    searchPokemonKnowledge,
    lookupPokemonEvolutions,
    analyzePokemonMatchups,
    lookupPokemonCards,
  ];
}