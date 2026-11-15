"use strict";

const $ = id => document.getElementById(id);
const resources = [
  ["Gold", "●"], ["Stone", "◆"], ["Food", "▰"], ["Books", "▤"],
  ["Military", "⚔"], ["Stability", "⛨"],
];
const ages = ["Antiquity", "Medieval", "Renaissance", "Industrial"];
let game;
let busy = false;

function node(tag, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function button(label, action, className = "choice") {
  const control = node("button", className, label);
  control.type = "button";
  control.addEventListener("click", action);
  return control;
}

function image(src, alt) {
  const el = node("img");
  el.src = src;
  el.alt = alt;
  return el;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function resourceLine(values, className, production = false) {
  const line = node("div", className);
  for (const [name, symbol] of resources) {
    const value = values?.[`[${name}]`] ?? 0;
    if (production && !value) continue;
    const chip = node("span", `resource ${name.toLowerCase()}`);
    chip.append(node("span", "icon", symbol), node("span", "", name),
      node("strong", "", production ? signed(value) : String(value)));
    chip.firstChild.setAttribute("aria-hidden", "true");
    line.append(chip);
  }
  return line;
}

function doMove(value) {
  if ($("inspector").open) $("inspector").close();
  update("/api/move", { move: value });
}

function optionsFor(slot, id) {
  return game.options.filter(({ value }) =>
    value === slot || value === `Buy ${slot}` || value === `Deploy to ${slot}`
    || value === `Undeploy from ${slot}` || value === `Special of "${game.card_details[id].name}"`);
}

function detailLines(card) {
  const items = [];
  if (card.military_requirement !== undefined) items.push(`Requires ${card.military_requirement} Military`);
  if (card.cost !== undefined) items.push(`Deploy for ${card.cost} Stone`);
  if (card.raid_value) items.push(`Raid value ${card.raid_value}`);
  if (card.stage_costs) items.push(`Architect stages: ${card.stage_costs.map(cost => -cost).join(" · ")} Stone`);
  if (card.completed_stages !== undefined) items.push(`${card.completed_stages} stages completed`);
  if (card.exploration_turns) items.push(`${card.exploration_turns} exploration turns`);
  if (card.points) items.push(`${card.points} VP`);
  if (card.penalty) items.push(`War penalty: ${card.penalty}`);
  return items;
}

function inspect(id, slot, allowMoves) {
  const card = game.card_details[id];
  const title = node("h2", "", card.name);
  title.id = "card-name";
  const body = node("div", "inspector-body");
  if (card.image) body.append(image(card.image, card.name));
  const info = node("div");
  info.append(node("p", "eyebrow", card.type), title);
  const effects = detailLines(card);
  if (effects.length) info.append(node("p", "card-rules", effects.join("\n")));
  const production = resourceLine(card.production, "resources compact", true);
  if (production.childElementCount) {
    info.append(node("p", "caption", card.per_worker ? "Per deployed worker" : "Card resources and stats"), production);
  }
  if (card.detail) info.append(node("p", "card-rules", card.detail));
  if (allowMoves) {
    for (const option of optionsFor(slot, id)) {
      info.append(button(option.label, () => doMove(option.value)));
    }
  }
  body.append(info);
  $("card-detail").replaceChildren(body);
  $("inspector").showModal();
}

function cardButton(id, slot, allowMoves, cardState) {
  const card = game.card_details[id];
  const el = button("", () => inspect(id, slot, allowMoves), "card");
  const dark = node("span", "card-art");
  if (card.image) dark.append(image(card.image, ""));
  else dark.append(node("span", "card-initial", card.name.slice(0, 1)));
  el.append(dark, node("strong", "card-name", card.name), node("span", "card-kind", card.type));
  if (cardState?.deployed) el.append(node("span", "workers", `${cardState.deployed} workers`));
  if (allowMoves && optionsFor(slot, id).length > 0) el.classList.add("available");
  return el;
}

function renderMarket() {
  const rows = [3, 2, 1].map(cost => {
    const row = node("div", "market-row");
    const shelf = node("div", "shelf");
    shelf.append(node("strong", "", String(cost)), node("span", "", "Gold"));
    row.append(shelf);
    for (let column = 1; column <= 4; column++) {
      const slot = `P${cost}${column}`;
      const id = game.progress_board[slot];
      row.append(id ? cardButton(id, slot, true) : node("div", "empty", "Empty"));
    }
    return row;
  });
  $("market").replaceChildren(...rows);
  $("supplies").replaceChildren(node("span", "counter", `${game.architects} architects`),
    node("span", "counter", `${game.turmoil} turmoil`));
}

function renderDraft() {
  $("draft").hidden = game.available_nations.length === 0;
  const nations = game.available_nations.map(name => {
    const nation = game.nations[name];
    const entry = node("article", "nation");
    const title = node("h3", "", name);
    entry.append(title);
    if (nation.image) entry.append(image(nation.image, `${name} starting board`));
    entry.append(resourceLine(nation.resources, "resources compact"));
    const cards = node("div", "owned-cards");
    for (const [slot, id] of Object.entries(nation.slots)) cards.append(cardButton(id, slot, false));
    for (const id of nation.dynasties) if (id) cards.append(cardButton(id, "", false));
    entry.append(cards);
    if (game.options.some(option => option.value === name)) {
      entry.append(button(`Draft ${name}`, () => doMove(name)));
    }
    return entry;
  });
  $("nations").replaceChildren(...nations);
}

function renderPlayers() {
  const boards = game.player_order.map((name, index) => {
    const player = game.players[name];
    const board = node("article", "panel player");
    const heading = node("div", "section-heading");
    const text = node("div");
    text.append(node("p", "eyebrow", `${index + 1} in turn order · ${name}`),
      node("h2", "", player.nation ?? "Awaiting draft"));
    heading.append(text);
    if (player.nation) heading.append(node("span", "counter", `${player.score} projected VP`));
    board.append(heading, resourceLine(player.resources, "resources"));
    if (!player.nation) return board;
    const status = node("div", "player-status");
    status.append(node("span", "", `${player.workers} idle workers`),
      node("span", "", player.passed ? "Passed" : `${player.turmoil} turmoil`));
    board.append(status);
    const production = resourceLine(player.production, "resources compact", true);
    if (production.childElementCount) {
      board.append(node("p", "caption", "Projected production"), production);
    }
    const slots = node("div", "owned-cards");
    for (const [slot, id] of Object.entries(player.slots)) {
      slots.append(cardButton(id, slot, name === game.human, player.cards[id]));
    }
    if (player.dynasties.some(Boolean)) {
      const dynasties = node("div", "owned-cards");
      for (const id of player.dynasties) if (id) dynasties.append(cardButton(id, "", false));
      board.append(slots, node("p", "caption", "Available dynasties"), dynasties);
    } else {
      board.append(slots);
    }
    return board;
  });
  $("boards").replaceChildren(...boards);
}

function renderEvent() {
  const cards = [];
  if (game.event) {
    const event = game.card_details[game.event];
    cards.push(node("h2", "", "Round events"), node("p", "card-rules", event.detail),
      node("p", "caption", `Famine: ${event.famine} Food`));
  }
  if (game.war) {
    const war = game.card_details[game.war];
    cards.push(node("h3", "", war.name), node("p", "", `Strength ${game.war_value} · ${war.penalty}`));
  }
  $("events").hidden = cards.length === 0;
  $("events").replaceChildren(...cards);
}

function render(focus = false) {
  const round = game.round;
  $("match-title").textContent = game.game_over ? "Match complete"
    : round === 0 ? "Nation draft" : `${ages[Math.floor((round - 1) / 2)]} · Round ${round}`;
  $("rounds").replaceChildren(...Array.from({ length: 8 }, (_, index) => {
    const item = node("span", index + 1 === round ? "current" : index + 1 < round ? "complete" : "", String(index + 1));
    if (index + 1 === round) item.setAttribute("aria-current", "step");
    return item;
  }));
  $("phase").textContent = game.game_over ? "Result" : game.phase;
  $("turn-title").textContent = game.game_over ? "Game over" : game.next_move_choice;
  const choices = game.game_over
    ? game.result.map(result => node("p", "result", `${result.name} · ${result.score} VP`))
    : game.options.map(option => button(option.label, () => doMove(option.value),
      option.value === "Resign" ? "choice resign" : "choice"));
  $("choices").replaceChildren(...choices);
  $("log").replaceChildren(...game.log.slice(-35).reverse().map(line => node("li", "", line)));
  renderDraft();
  renderMarket();
  renderPlayers();
  renderEvent();
  if (focus) $("turn-title").focus({ preventScroll: true });
}

async function readState() {
  const response = await fetch("/api/game");
  if (!response.ok) throw new Error("Could not load the board.");
  game = await response.json();
}

async function update(path, payload) {
  if (busy || !game) return;
  busy = true;
  $("error").hidden = true;
  $("choices").inert = true;
  $("phase").textContent = "Updating board…";
  try {
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, revision: game.revision }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save the move.");
    game = data;
    render(true);
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    try {
      await readState();
      render();
    } catch {
      $("phase").textContent = "Connection lost";
    }
  } finally {
    $("choices").inert = false;
    busy = false;
  }
}

$("new-game").addEventListener("click", () => {
  if (game && (game.game_over || confirm("Start a new game and replace the current local save?"))) {
    update("/api/new", {});
  }
});
readState().then(() => render()).catch(error => {
  $("error").textContent = error.message;
  $("error").hidden = false;
});
