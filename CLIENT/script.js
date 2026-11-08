const chatbox = document.getElementById("chatbox");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("message");
const sendBtn = document.getElementById("sendBtn");

const storageKey = "pokemon-agent-session-id";

function getSessionId() {
  let sessionId = localStorage.getItem(storageKey);

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem(storageKey, sessionId);
  }

  return sessionId;
}

const sessionId = getSessionId();

function addMessage(text, sender) {
  const element = document.createElement("article");
  element.classList.add("message", sender);

  if (sender === "bot") {
    element.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    element.textContent = text;
  }

  chatbox.appendChild(element);
  chatbox.scrollTop = chatbox.scrollHeight;
  return element;
}

function addPokemonCards(title, pokemonList) {
  if (!pokemonList?.length) return;

  const section = document.createElement("section");
  section.classList.add("pokemon-section");

  const heading = document.createElement("h3");
  heading.textContent = title;
  section.appendChild(heading);

  const cards = document.createElement("div");
  cards.classList.add("pokemon-cards");

  for (const pokemon of pokemonList) {
    const card = document.createElement("article");
    card.classList.add("pokemon-card");

    if (pokemon.sprite) {
      const image = document.createElement("img");
      image.src = pokemon.sprite;
      image.alt = pokemon.name;
      image.loading = "lazy";
      card.appendChild(image);
    }

    const name = document.createElement("strong");
    name.textContent = pokemon.name;
    card.appendChild(name);

    if (pokemon.types?.length) {
      const types = document.createElement("span");
      types.textContent = pokemon.types.join(" / ");
      card.appendChild(types);
    }

    if (Number.isInteger(pokemon.level)) {
      const level = document.createElement("span");
      level.textContent = `Lv. ${pokemon.level}`;
      card.appendChild(level);
    }

    cards.appendChild(card);
  }

  section.appendChild(cards);
  chatbox.appendChild(section);
  chatbox.scrollTop = chatbox.scrollHeight;
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const prompt = messageInput.value.trim();
  if (!prompt) return;

  messageInput.value = "";
  addMessage(prompt, "user");

  sendBtn.disabled = true;
  messageInput.disabled = true;
  sendBtn.textContent = "Even wachten...";

  const loadingMessage = addMessage("De agent denkt na...", "bot");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, sessionId }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Er ging iets mis.");
    }

    loadingMessage.remove();
    const gymLists = (data.pokemonLists ?? []).filter((list) => list.isGym);
    for (const list of gymLists) {
      addPokemonCards(list.title, list.pokemon);
    }

    addMessage(data.reply, "bot");
    if (data.recommendations?.length) {
      addPokemonCards(data.teamTitle || "Aanbevolen team", data.recommendations);
      addPokemonCards(
        "Goede alternatieven (kies in plaats van een teamlid)",
        data.alternatives,
      );
    }
    for (const list of (data.pokemonLists ?? []).filter((item) => !item.isGym)) {
      addPokemonCards(list.title, list.pokemon);
    }
  } catch (error) {
    loadingMessage.remove();
    addMessage(error.message, "error");
  } finally {
    sendBtn.disabled = false;
    messageInput.disabled = false;
    sendBtn.textContent = "Verstuur";
    messageInput.focus();
  }
});

addMessage(
  "Hoi! Welke Pokémon-game speel je, en waar wil je hulp bij?",
  "bot",
);