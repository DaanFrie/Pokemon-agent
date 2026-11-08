import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const documentsDirectory = path.join(currentDirectory, "documents");
const startMarker = "=== POKÉMON TYPE-REFERENTIE (AUTOMATISCH GEGENEREERD) ===";
const endMarker = "=== EINDE POKÉMON TYPE-REFERENTIE ===";
const generations = {
  "red.txt": 1,
  "fire-red.txt": 3,
  "gold.txt": 2,
  "heartgold.txt": 4,
  "ruby.txt": 3,
  "emerald.txt": 3,
  "diamond.txt": 4,
  "platinum.txt": 4,
  "black.txt": 5,
  "black_2.txt": 5,
};
const nameAliases = new Map([
  ["farfetch'd", "farfetchd"],
  ["mr. mime", "mr-mime"],
  ["mime jr.", "mime-jr"],
  ["rotom-forms", "rotom"],
  ["wormadam", "wormadam-plant"],
  ["basculin", "basculin-red-striped"],
  ["darmanitan", "darmanitan-standard"],
  ["giratina", "giratina-altered"],
  ["shaymin", "shaymin-land"],
  ["tornadus", "tornadus-incarnate"],
  ["thundurus", "thundurus-incarnate"],
  ["landorus", "landorus-incarnate"],
  ["keldeo", "keldeo-ordinary"],
  ["meloetta", "meloetta-aria"],
  ["deoxys", "deoxys-normal"],
  ["delicatty", "delcatty"],
]);

function slugFor(name) {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    nameAliases.get(normalized) ??
    normalized.replace(/[.'’]/g, "").replace(/\s+/g, "-")
  );
}

function addPokemonName(names, rawName) {
  for (const candidate of rawName.split("/")) {
    const name = candidate.trim().replace(/\s*\([^)]*\)\s*$/, "");
    if (name && /^[A-Za-z][A-Za-z'. -]*$/.test(name)) {
      names.add(name);
    }
  }
}

function extractPokemonNames(text) {
  const names = new Set();
  const tierStart = text.search(/TIER LIST[^:]*:/i);
  const rosterText = tierStart < 0 ? text : text.slice(0, tierStart);

  for (const line of rosterText.split(/\r?\n/)) {
    let teamText = line;
    const firstLevel = line.search(/\(Lv\.?\s*\d+/i);
    if (firstLevel >= 0) {
      const teamSeparator = line.lastIndexOf(" - ", firstLevel);
      if (teamSeparator >= 0) {
        teamText = line.slice(teamSeparator + 3);
      }
    }

    for (const segment of teamText.split(",")) {
      const pokemon = segment.match(/^\s*(.+?)\s*\(Lv\.?\s*\d+\)/i);
      if (pokemon) {
        addPokemonName(names, pokemon[1]);
      }
    }
  }

  const tierText = tierStart < 0 ? "" : text.slice(tierStart);
  for (const line of tierText.split(/\r?\n/)) {
    const tier = line.match(/^\s*[SABCD]\+?[- ]?Tier\b.*?:\s*(.+)$/i);
    if (!tier) {
      continue;
    }

    for (const rawName of tier[1].split(",")) {
      addPokemonName(names, rawName);
    }
  }

  if (names.size === 0) {
    throw new Error("Geen Pokémon gevonden in gymrosters of tierlijsten.");
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

async function fetchPokemon(slug) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      let response = await fetch(
        `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(slug)}`,
      );
      if (response.status === 404) {
        const speciesResponse = await fetch(
          `https://pokeapi.co/api/v2/pokemon-species/${encodeURIComponent(slug)}`,
        );
        if (speciesResponse.ok) {
          const species = await speciesResponse.json();
          response = await fetch(
            `https://pokeapi.co/api/v2/pokemon/${species.id}`,
          );
        }
      }
      if (!response.ok) {
        throw new Error(`PokéAPI-status ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw new Error(`PokéAPI-data voor "${slug}" niet beschikbaar: ${lastError.message}`);
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function getTypesForGeneration(pokemon, generation) {
  const pastTypes = [...(pokemon.past_types ?? [])]
    .map((entry) => ({
      generation: generationNumber(entry.generation.name),
      types: entry.types
        .sort((left, right) => left.slot - right.slot)
        .map((entry) => entry.type.name),
    }))
    .filter((entry) => Number.isInteger(entry.generation))
    .filter((entry) => entry.generation >= generation)
    .sort((left, right) => left.generation - right.generation);

  const types = pastTypes[0]?.types ??
    pokemon.types.sort((left, right) => left.slot - right.slot).map((entry) => entry.type.name);
  return generation === 1
    ? types.filter((type) => type !== "dark" && type !== "steel" && type !== "fairy")
    : types.filter((type) => type !== "fairy");
}

function generationNumber(name) {
  const roman = name.replace("generation-", "").toLowerCase();
  const values = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9 };
  return values[roman];
}

function parseTypeChart(text, generation) {
  const chart = new Map();
  let multiplier = null;
  let section = "";

  for (const line of text.split(/\r?\n/)) {
    if (/SUPER EFFECTIEF/i.test(line)) {
      section = "attacking";
      multiplier = 2;
      continue;
    }
    if (/NIET ERG EFFECTIEF/i.test(line)) {
      section = "attacking";
      multiplier = 0.5;
      continue;
    }
    if (/GEEN EFFECT/i.test(line)) {
      section = "immunity";
      multiplier = 0;
      continue;
    }

    if (section === "attacking") {
      const matchup = line.match(/^\s*-\s*([\w-]+)\s*:\s*(.+)\.\s*$/);
      if (matchup && !/^geen\.?$/i.test(matchup[2])) {
        for (const defender of matchup[2].split(",").map((type) => type.trim().toLowerCase())) {
          chart.set(`${matchup[1].toLowerCase()}:${defender}`, multiplier);
        }
      }
    } else if (section === "immunity") {
      const immunity = line.match(/^\s*-\s*([\w-]+)\s*->\s*([\w-]+)\./);
      if (immunity) {
        chart.set(`${immunity[1].toLowerCase()}:${immunity[2].toLowerCase()}`, 0);
      }
    }
  }

  if (generation === 1) {
    chart.delete("ice:fire");
    chart.set("poison:bug", 2);
    chart.set("ghost:psychic", 0);
  }
  const unavailableTypes =
    generation === 1 ? ["dark", "steel", "fairy"] : ["fairy"];
  for (const key of [...chart.keys()]) {
    const [attackType, defendType] = key.split(":");
    if (unavailableTypes.includes(attackType) || unavailableTypes.includes(defendType)) {
      chart.delete(key);
    }
  }
  return chart;
}

function multiplierForAttack(chart, attackType, defendTypes) {
  return defendTypes.reduce(
    (result, defendType) =>
      result * (chart.get(`${attackType}:${defendType}`) ?? 1),
    1,
  );
}

function summarizeMultipliers(groups) {
  return [...groups]
    .sort((left, right) => left[0] - right[0])
    .map(([multiplier, types]) => `${multiplier}x vs ${types.join(", ")}`)
    .join("; ") || "alle types doen neutrale schade (1x)";
}

function createPokemonEntry(name, types, chart, availableTypes) {
  if (types.length === 0) {
    throw new Error(`Geen geldige types gevonden voor ${name}.`);
  }

  const attackGroups = new Map();
  for (const attackType of types) {
    const groups = new Map();
    for (const defendType of availableTypes) {
      const multiplier = multiplierForAttack(chart, attackType, [defendType]);
      if (multiplier !== 1) {
        groups.set(multiplier, [...(groups.get(multiplier) ?? []), defendType]);
      }
    }
    attackGroups.set(attackType, summarizeMultipliers(groups));
  }

  const defenseGroups = new Map();
  for (const attackType of availableTypes) {
    const multiplier = multiplierForAttack(chart, attackType, types);
    if (multiplier !== 1) {
      defenseGroups.set(multiplier, [
        ...(defenseGroups.get(multiplier) ?? []),
        attackType,
      ]);
    }
  }

  const offense = [...attackGroups]
    .map(([type, summary]) => `${type}: ${summary}`)
    .join(" | ");

  return `- ${name} — typing ${types.join("/")}. Eigen STAB-aanval per type: ${offense}. Schade die deze Pokémon ontvangt: ${summarizeMultipliers(defenseGroups)}.`;
}

function replaceGeneratedSection(text, section) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  const cleanText =
    start >= 0
      ? text.slice(0, start).trimEnd()
      : text.trimEnd();
  if (start >= 0 && end < start) {
    throw new Error("Gegenereerde typebijlage heeft geen eindmarkering.");
  }
  const suffix = start >= 0 ? text.slice(end + endMarker.length).trim() : "";
  return `${cleanText}\n\n${section}${suffix ? `\n\n${suffix}` : ""}\n`;
}

const typeChartText = await readFile(
  path.join(documentsDirectory, "type_effectiveness.txt"),
  "utf8",
);
const typeCache = new Map();
const gameFiles = Object.keys(generations);
const documentContents = new Map();
const speciesByGame = new Map();

const updatedDocuments = new Map();
for (const file of gameFiles) {
  const content = await readFile(path.join(documentsDirectory, file), "utf8");
  documentContents.set(file, content);
  speciesByGame.set(file, extractPokemonNames(content));
}

const allSlugs = [
  ...new Set([...speciesByGame.values()].flat().map(slugFor)),
];
const fetched = await mapWithConcurrency(allSlugs, 6, async (slug) => {
  const pokemon = await fetchPokemon(slug);
  typeCache.set(slug, pokemon);
  return slug;
});
console.log(`PokéAPI-typegegevens geladen voor ${fetched.length} Pokémon.`);

for (const file of gameFiles) {
  const generation = generations[file];
  const chart = parseTypeChart(typeChartText, generation);
  const availableTypes = [
    "normal", "fire", "water", "electric", "grass", "ice", "fighting",
    "poison", "ground", "flying", "psychic", "bug", "rock", "ghost",
    "dragon", "dark", "steel",
  ].filter((type) => generation !== 1 || !["dark", "steel"].includes(type));
  const entries = speciesByGame.get(file).map((name) => {
    const pokemon = typeCache.get(slugFor(name));
    if (!pokemon) {
      throw new Error(`Ontbrekende PokéAPI-data voor ${name} in ${file}.`);
    }
    const types = getTypesForGeneration(pokemon, generation);
    return createPokemonEntry(name, types, chart, availableTypes);
  });

  const section = [
    startMarker,
    `Per-Pokémon typing en type-effectiviteit voor ${file} (generatie ${generation}).`,
    "Aanval bevat alleen STAB-typen; moves kunnen andere typen hebben en staan hier niet in. Schade 1x of niet vermelde typen zijn neutraal. Dubbeltypes zijn doorgerekend.",
    ...entries,
    endMarker,
  ].join("\n");
  const updated = replaceGeneratedSection(documentContents.get(file), section);
  updatedDocuments.set(file, updated);
}

for (const [file, updated] of updatedDocuments) {
  await writeFile(path.join(documentsDirectory, file), updated, "utf8");
  const entryCount = (updated.match(/^- .+ — typing /gm) ?? []).length;
  console.log(`${file}: ${entryCount} Pokémon toegevoegd.`);
}
