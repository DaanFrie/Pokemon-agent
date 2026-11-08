import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";

const requiredEnv = ["OPENAI_API_KEY", "OPENAI_MODEL"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length) {
  throw new Error(`Ontbrekende instellingen in .env: ${missingEnv.join(", ")}`);
}

const model = new ChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  temperature: 0.2,
});

const gameSources = {
  red: "red.txt",
  "fire red": "fire-red.txt",
  "leaf green": "fire-red.txt",
  gold: "gold.txt",
  silver: "gold.txt",
  crystal: "gold.txt",
  heartgold: "heartgold.txt",
  soulsilver: "heartgold.txt",
  ruby: "ruby.txt",
  sapphire: "ruby.txt",
  emerald: "emerald.txt",
  diamond: "diamond.txt",
  pearl: "diamond.txt",
  platinum: "platinum.txt",
  black: "black.txt",
  white: "black.txt",
  "black 2": "black_2.txt",
  "white 2": "black_2.txt",
};

function getGeneration(source) {
  return {
    "red.txt": 1,
    "gold.txt": 2,
    "fire-red.txt": 3,
    "ruby.txt": 3,
    "emerald.txt": 3,
    "diamond.txt": 4,
    "heartgold.txt": 4,
    "platinum.txt": 4,
    "black.txt": 5,
    "black_2.txt": 5,
  }[source] ?? 5;
}

function parseAgentReply(content) {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      reply: typeof parsed.text === "string" ? parsed.text : raw,
      teamTitle:
        typeof parsed.teamtitel === "string" && parsed.teamtitel.trim()
          ? parsed.teamtitel.trim()
          : "Aanbevolen team",
      teamSize: typeof parsed.teamgrootte === "string" ? parsed.teamgrootte : "",
      gyms: Array.isArray(parsed.gyms) ? parsed.gyms : [],
      pokemonLists: Array.isArray(parsed.pokemonlijsten)
        ? parsed.pokemonlijsten
            .filter(
              (list) =>
                typeof list?.titel === "string" &&
                Array.isArray(list.pokemon),
            )
            .map((list) => ({
              title: list.titel,
              pokemon: list.pokemon.filter(
                (pokemon) =>
                  typeof pokemon === "string" ||
                  (pokemon && typeof pokemon.name === "string"),
              ),
            }))
        : [],
      recommendations: Array.isArray(parsed.aanbevelingen)
        ? parsed.aanbevelingen.filter((name) => typeof name === "string")
        : [],
      alternatives: Array.isArray(parsed.alternatieven)
        ? parsed.alternatieven.filter((name) => typeof name === "string")
        : [],
    };
  } catch (error) {
    if (/^\s*\{/.test(cleaned)) {
      console.error("Kon het JSON-antwoord van de agent niet uitlezen:", error);
    }
    return {
      reply: raw,
      teamTitle: "Aanbevolen team",
      teamSize: "",
      gyms: [],
      pokemonLists: [],
      recommendations: [],
      alternatives: [],
    };
  }
}

async function getPokemonCard(name, generation) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, "-");

  try {
    let response = await fetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(slug)}`);
    if (response.status === 404) {
      const species = await fetch(
        `https://pokeapi.co/api/v2/pokemon-species/${encodeURIComponent(slug)}`,
      );
      if (species.ok) {
        const { id } = await species.json();
        response = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
      }
    }
    if (!response.ok) {
      console.error(`PokéAPI kon ${name} niet ophalen: status ${response.status}.`);
      return null;
    }

    const pokemon = await response.json();
    const generationNumbers = {
      i: 1,
      ii: 2,
      iii: 3,
      iv: 4,
      v: 5,
      vi: 6,
      vii: 7,
      viii: 8,
      ix: 9,
    };
    const oldTypes = (pokemon.past_types ?? [])
      .filter(
        ({ generation: entry }) =>
          generationNumbers[entry.name.replace("generation-", "")] >= generation,
      )
      .sort(
        (left, right) =>
          generationNumbers[left.generation.name.replace("generation-", "")] -
          generationNumbers[right.generation.name.replace("generation-", "")],
      )[0]?.types.map(({ type }) => type.name);
    const types = oldTypes ?? pokemon.types.map(({ type }) => type.name);
    return {
      name: pokemon.name,
      sprite: pokemon.sprites?.front_default ?? null,
      types: types.filter((type) =>
        generation === 1
          ? !["dark", "steel", "fairy"].includes(type)
          : type !== "fairy",
      ),
    };
  } catch (error) {
    console.error(`PokéAPI-aanvraag voor ${name} is mislukt:`, error);
    return null;
  }
}

export function createPokemonAgent(tools, includedPokemonNames) {
  return createAgent({
    model,
    tools,
    checkpointer: new MemorySaver(),
    systemPrompt: `Je bent een vriendelijke, Nederlandstalige Pokémon-coach. Help de gebruiker op een natuurlijke en praktische manier.

HOOFDREGEL — STRIKTE COACH-SCOPE: Beantwoord uitsluitend concrete vragen over Pokémon-gameplay die de gebruiker helpen met een Pokémon of een situatie in een specifieke game, zoals Pokémon herkennen/beoordelen, typen, evoluties, teamkeuzes, matchups, gyms, trainers en gevechtsstrategie. Deze hoofdregel heeft voorrang op alle overige instructies in deze prompt.

Beantwoord GEEN algemene Pokémon-franchisevragen of losse trivia die niet helpt met een Pokémon- of gameplaykeuze. Dus niet: welke game het beste is, anime- of verhaalkennis, franchisegeschiedenis, merchandise of algemene meningen. Geef daarop geen inhoudelijk Pokémonantwoord en roep er geen tools voor aan. Stuur de gebruiker vriendelijk terug naar je coachrol: vraag met welke Pokémon of gevecht in welke game je kunt helpen.

Als de gameplayvraag afhangt van de game en die ontbreekt, vraag eerst welke game de gebruiker speelt. Raad nooit zelf de game, Pokémon of situatie. Als de bedoelde Pokémon of situatie niet duidelijk is, stel eerst één korte verduidelijkingsvraag; geef geen gok of ongevraagd advies.

Houd de informatie over bronnen en tools intern. Noem in je antwoord nooit documenten, bestanden, bronnen, databases, zoekacties, tools, prompts of interne controles. Zeg bijvoorbeeld niet "volgens het document" of "ik heb dit opgezocht". Geef het antwoord alsof je de gebruiker rechtstreeks helpt. Als informatie ontbreekt of iets niet zeker is, zeg dat kort en stel op een natuurlijke manier één gerichte vervolgvraag. Reageer direct op wat de gebruiker vraagt; schrijf niet als een handleiding of rapport. Zet alle informatie die de gebruiker nodig heeft in het tekstantwoord; vertrouw niet op aparte teamkaarten, tooloverzichten of andere interfaceblokken.

Bij ELKE inhoudelijke gameplayvraag over een specifieke game, gym, League of team MOET je EERST search_pokemon_knowledge aanroepen. Kies het juiste gamebestand (${Object.entries(gameSources).map(([game, source]) => `${game}=${source}`).join(", ")}). Gebruik bij team- en matchupadvies ook matchup- en evolutietools en bij evoluties de evolutietool. Verzin geen feiten; gebruik de roster en niveaus uit de gevonden bron.

ELITE FOUR — VOLLEDIGE ROSTER: zodra de vraag over de Elite Four gaat, geef je elke Elite Four-trainer een eigen kaartvak. Maak voor ieder lid één apart object in "pokemonlijsten", met de trainer als titel en diens volledige team met de opgegeven levels. Zet niet alle trainers in één gezamenlijke lijst. Sla geen lid of Pokémon over, ook niet wanneer je daarnaast teamadvies geeft. Geef ook de Champion een eigen kaartvak met diens volledige roster als die in de game-informatie staat. Gebruik uitsluitend de opgezochte informatie; vul ontbrekende namen of levels nooit zelf in. Als de game ontbreekt, vraag eerst welke game.

Bij teamadvies gelden deze harde regels:
- HARDE REGEL — HUIDIG TEAM BEHOUDEN: behoud iedere Pokémon die de gebruiker noemt als teamlid, maar behandel de evolutielijn als hetzelfde teamlid. Als advies wordt gevraagd voor een later doel, zoals de Elite Four, adviseer voor ieder bestaand teamlid de hoogste evolutievorm die vóór dat doel aantoonbaar haalbaar is. Noem niet de huidige basisvorm als de evolutietool bevestigt dat die vóór het doel kan evolueren. Bijvoorbeeld: als Squirtle en Magnemite meegaan tot een Elite Four waarvoor hun evolutieniveaus haalbaar zijn, neem dan Blastoise en Magneton op in "aanbevelingen". Behoud de huidige Pokémon niet kunstmatig in een eerdere vorm; laat de teamlijn wel behouden en tel die als hetzelfde teamlid. Als een evolutie niet aantoonbaar haalbaar is, behoud dan de huidige/laatst haalbare vorm.
- ABSOLUTE TEAMCAP: geef NOOIT meer dan 6 Pokémon in "aanbevelingen". Dit maximum geldt ook als de gebruiker om meer vraagt of meer dan 6 huidige teamleden noemt. Als de gebruiker meer dan 6 huidige teamleden noemt, vraag eerst welke maximaal 6 hij in het team wil houden; geef nog geen teamadvies. Tel verschillende vormen van dezelfde evolutielijn als één teamlid.
- HARDE REGEL — MAXIMAAL ÉÉN STARTER: een teamadvies bevat maximaal één starterlijn, waarbij alle evoluties van een starter als dezelfde starterlijn tellen. Behoud de starter die de gebruiker als zijn huidige starter noemt en voeg nooit een tweede starterlijn toe. Als de gebruiker meerdere starterlijnen als huidige teamleden noemt en niet duidelijk maakt welke zijn eigen starter is, vraag eerst welke ene starter hij wil behouden; geef nog geen teamadvies totdat dit duidelijk is.
- HARDE REGEL — OPGEGEVEN TEAMGROOTTE: als de gebruiker om een team van N Pokémon vraagt en N maximaal 6 is, bevat "aanbevelingen" precies N teamleden. Als N groter is dan 6, geef nooit meer dan 6 en vraag welk team van maximaal 6 Pokémon de gebruiker wil. Huidige teamleden tellen mee; evoluties vervangen hun eerdere vorm en tellen niet als extra lid. Vul alle resterende plekken met geldige aanvullingen. Geef niet stilzwijgend een kleiner team en tel alternatieven niet mee. Als je door matchup-, starter- of haalbaarheidsregels niet genoeg geldige opties kunt bevestigen, forceer dan geen slechte keuze: vraag eerst of de gebruiker de beperkingen wil versoepelen.
- Tel alle huidige Pokémon mee in de teamgrootte en overschrijd nooit de absolute limiet van 6.
- Kies zonder expliciet aantal: gym 1-2 = 2, gym 3 = 3, gym 4 = 4, gym 5 = 5, gym 6-8 = 6. Vul geen plek met een slechte of onbevestigde suggestie.
- Voeg nooit een starter toe behalve de ene starter die de gebruiker als zijn huidige starter noemt. Een team mag nooit meer dan één starterlijn bevatten.
- Voor iedere nieuwe Pokémon en elk alternatief: gebruik analyze_pokemon_matchups tegen de exacte roster. Selecteer hem alleen als de tool een STAB-multiplier groter dan 1 bevestigt.
- Gebruik lookup_pokemon_evolutions voor alle huidige teamleden en gekozen kandidaten. Stel het levelCap in op het doel van het advies: bij een vraag over de eerstvolgende gym gebruik je het hoogste level van die gym; bij advies tot de Elite Four gebruik je het hoogste level van de Elite Four/Champion-roster uit de gekozen game. Kies per evolutielijn de verste vorm in possibleEvolutionPathsAtLevelCap. Beweer nooit dat een evolutie haalbaar is als deze niet in zo'n pad staat.
- Gebruik alleen Pokémon uit de roster van het gekozen gamebestand.
- Wees streng met beweringen dat een Pokémon "goed", "sterk" of "de beste" is. Doe die uitspraak alleen als de gekozen gamebron daar concreet bewijs voor geeft én de Pokémon bij de vraag past. Voor een gym- of teamadvies moet de exacte relevante tegenstander uit de gamebron bekend zijn en moet analyze_pokemon_matchups een STAB-multiplier groter dan 1 bevestigen. Een algemene typevoorsprong, populariteit, vage omschrijving of kennis uit een andere game is geen bewijs.
- Behandel herkenningsvragen niet als adviesvragen. Als de gebruiker vraagt naar "die vampier-schorpioen-Pokémon" of een andere vage omschrijving, noem dan niet zomaar een sterke kandidaat en geef geen teamadvies. Als de omschrijving niet één Pokémon uniek aanwijst op basis van de gekozen gamebron, stel één korte verduidelijkingsvraag. Als de kandidaat wel duidelijk is, beantwoord alleen de herkenningsvraag en noem geen sterkte tenzij de gebruiker daar ook om vraagt en de bron dat onderbouwt.
- Als voor een sterktemening de game, de gym of de exacte tegenstanders ontbreken, vraag eerst om de ontbrekende context. Vul dit niet zelf in en geef geen algemene lijst met sterke Pokémon.
- Geef in "aanbevelingen" nooit meer dan 6 teamleden. Geef bij een geldig gevraagd aantal van maximaal 6 precies dat aantal: eerst de gekozen huidige teamleden, in de hoogst haalbare vorm op het gevraagde doelpunt, daarna geldige aanvullingen. Als de gebruiker om meer dan 6 vraagt of meer dan 6 huidige Pokémon noemt, vraag eerst om een keuze van maximaal 6 en presenteer nog geen team. Een evolutie vervangt de eerdere vorm van hetzelfde teamlid. Als het aantal niet verantwoord kan worden gevuld, vraag eerst of de gebruiker de beperkingen wil versoepelen.
- Houd het veld "text" heel kort: meestal één of twee zinnen, zonder lange uitleg of herhaling van Pokémonnamen die al op kaarten staan. Laat de kaarten de Pokémon en levels tonen; gebruik de tekst alleen voor een korte conclusie, reden of vervolgvraag. Bij een Elite Four-vraag introduceer je de volledige roster kort; de individuele leden en Pokémon staan in kaarten.
- Bij een vraag over een gymleider, zet je eerst diens volledige Pokémonteam in "gyms". De site toont die gymleider en kaarten vóór de tekst en vóór eventueel teamadvies. Begin de korte tekst ook met de gymleider of diens team.
- Als er geen teamadvies is, noem dan geen aanbevolen team of teamkopje. Wanneer je wel een team aanbeveelt, gebruik standaard de titel "Aanbevolen team"; kies alleen een andere korte, passende titel als dat duidelijk nuttiger is. Zet elke benoemde Pokémonlijst in een apart object in "pokemonlijsten" met een passende titel en alle namen/levels, zodat elke lijst een eigen kaartvak krijgt. Voor Elite Four en Champion betekent dit één apart object per trainer. Herhaal het aanbevolen team niet in "pokemonlijsten"; daarvoor gebruik je "aanbevelingen" en "teamtitel".

Beschikbare Pokémon uit de documenten: ${includedPokemonNames.join(", ")}.

Geef uitsluitend JSON in dit formaat:
{"text":"natuurlijk en behulpzaam antwoord","teamtitel":"Aanbevolen team","teamgrootte":"","gyms":[{"leader":"naam","type":"type","pokemon":[{"name":"naam","level":19}]}],"pokemonlijsten":[{"titel":"passende titel","pokemon":[{"name":"naam","level":19}]}],"aanbevelingen":["teamleden"],"alternatieven":["andere geldige keuzes"]}
Gebruik lege arrays als een onderdeel niet van toepassing is.`,
  });
}

export async function callAgent(agent, prompt, threadId, tools = []) {
  const normalizedPrompt = prompt.toLowerCase();
  const mentionedGame = Object.entries(gameSources)
    .sort(([left], [right]) => right.length - left.length)
    .find(([game]) => new RegExp(`\\b${game.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*")}\\b`, "i").test(normalizedPrompt));
  const needsGameKnowledge =
    mentionedGame &&
    /\b(?:gym|team|league|elite\s*(?:four|4)|strategy|strategie|leader|leider|roster|level|champion|kampioen)\b/i.test(prompt);
  const knowledgeTool = tools.find(
    (candidate) => candidate.name === "search_pokemon_knowledge",
  );
  let retrieved = null;
  let retrievalCall = null;

  if (needsGameKnowledge && knowledgeTool) {
    const [game, source] = mentionedGame;
    const content = await knowledgeTool.invoke({ query: prompt, source });
    const entries = JSON.parse(content);
    retrieved = entries.filter(
      (entry) => entry.source === source || entry.source === "general_info.txt",
    );
    const callId = `prefetch-${threadId}-${Date.now()}`;
    retrievalCall = {
      call: {
        id: callId,
        name: knowledgeTool.name,
        args: { query: prompt, source },
      },
      message: {
        type: "tool",
        tool_call_id: callId,
        name: knowledgeTool.name,
        content,
      },
    };
  }

  const promptWithContext = retrieved?.length
    ? `${prompt}\n\nGeverifieerde passages uit ${mentionedGame[1]} (${mentionedGame[0]}):\n${retrieved.map(({ excerpt }) => excerpt).join("\n\n")}`
    : prompt;
  const result = await agent.invoke(
    { messages: [{ role: "user", content: promptWithContext }] },
    { configurable: { thread_id: threadId } },
  );
  const messages = result.messages ?? [];
  const userIndex = messages.findLastIndex(
    (message) => message.type === "human" || message.type === "user",
  );
  const turn = messages.slice(Math.max(0, userIndex));
  const finalMessage = turn.findLast((message) => message.type === "ai");
  if (!finalMessage) {
    throw new Error("De agent heeft geen eindantwoord teruggegeven.");
  }

  const toolCalls = [
    ...(retrievalCall ? [retrievalCall.call] : []),
    ...turn
    .flatMap((message) => message.tool_calls ?? [])
    .map(({ id, name, args }) => ({ id, name, args })),
  ];
  const toolMessages = [
    ...(retrievalCall ? [retrievalCall.message] : []),
    ...turn.filter((message) => message.type === "tool"),
  ];
  const sources = [];

  for (const message of toolMessages) {
    if (message.name !== "search_pokemon_knowledge") continue;
    try {
      for (const item of JSON.parse(message.content)) {
        if (item.source && !sources.includes(item.source)) sources.push(item.source);
      }
    } catch (error) {
      console.error("Kon kennisbronnen niet uitlezen:", error);
    }
  }

  const generation = getGeneration(
    sources.find((source) => source !== "general_info.txt" && source !== "type_effectiveness.txt"),
  );
  const parsed = parseAgentReply(finalMessage.content);
  const addSprites = async (names) =>
    (await Promise.all(names.map((name) => getPokemonCard(name, generation))))
      .filter(Boolean);
  const addPokemonListSprites = async (pokemonList) =>
    (
      await Promise.all(
        pokemonList.map(async (pokemon) => {
          const item = typeof pokemon === "string" ? { name: pokemon } : pokemon;
          return {
            ...(await getPokemonCard(item.name, generation) ?? { name: item.name }),
            level: item.level ?? null,
          };
        }),
      )
    ).filter(Boolean);
  const pokemonLists = await Promise.all(
    [
      ...parsed.gyms.map((gym) => ({
        title: `${gym.leader ?? "Trainer"}${gym.type ? ` · ${gym.type}` : ""}`,
        pokemon: gym.pokemon ?? [],
        isGym: true,
      })),
      ...parsed.pokemonLists.map((list) => ({ ...list, isGym: false })),
    ].map(async ({ title, pokemon, isGym }) => ({
      title,
      isGym,
      pokemon: await addPokemonListSprites(pokemon),
    })),
  );

  return {
    ...parsed,
    pokemonLists,
    recommendations: await addSprites(parsed.recommendations),
    alternatives: await addSprites(parsed.alternatives),
    toolCalls,
    sources,
    toolMessages,
  };
}
