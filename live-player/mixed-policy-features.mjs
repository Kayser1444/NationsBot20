import cards from './card-index.json' with { type: 'json' };

// Mirrors the benchmarked current-position-mixed-settings-v1 encoder.
const resources = ['Food', 'Stone', 'Gold', 'Books', 'Military', 'Stability'];
const types = ['building', 'military', 'advisor', 'colony', 'wonder', 'natural-wonder', 'battle', 'golden-age', 'war'];
const actions = ['draft', 'buy', 'deploy', 'undeploy', 'hire', 'explore', 'special', 'pass', 'turmoil', 'dynasty', 'resources', 'other'];
const slotGroups = [['A', 2], ['BM', 6], ['S', 2], ['C', 4], ['W', 6]];
const slots = ([prefix, count]) => Array.from({ length: count }, (_, index) => prefix + (index + 1));
const owned = [...slotGroups.flatMap(slots), 'Hire'];
const wonders = slots(['W', 6]);
const marketSlots = [1, 2, 3].flatMap(row => slots([`P${row}`, 4]));
const placements = new Set(['Place wonder where?', 'Place natural wonder where?']);
const oneHot = (options, value) => options.map(option => Number(value === option));
const sum = values => values.reduce((total, value) => total + value, 0);
const amount = (values, resource) => values?.[`[${resource}]`] ?? 0;
const capacity = nation => !nation ? 0 : ['China', 'Poland'].includes(nation) ? 6 : 5;
const korea = ['K_S', 'K_S_Nerf'];
const lincoln = ['AhLc', 'AhLc_Nerf'];
const catalog = { ...cards, AhLc_Nerf: cards.AhLc };
const card = id => Object.hasOwn(catalog, id) ? catalog[id] : {};
export const mixedAbilityIds = Object.keys(cards).filter(id => {
  const info = cards[id];
  return ['advisor', 'dynasty', 'wonder', 'natural-wonder'].includes(info.type) &&
    (info.description || info.privateArchitects || info.goldenAgeBonus);
}).sort();
const abilityIndex = new Map(mixedAbilityIds.map((id, index) => [id, index]));
const ability = id => abilityIndex.get(id === 'AhLc_Nerf' ? 'AhLc' : id);
const abilityFlags = () => Array(mixedAbilityIds.length).fill(0);
const names = new Map(Object.entries(cards).filter(([, info]) => info.name).map(([id, info]) => [info.name, id]));

export const mixedFeatureRules = {
  card,
  identity: id => ability(id) === undefined,
  moveToken(move) {
    if (ability(names.get(move)) !== undefined) return 'Card';
    return move.replace(/"([^"]+)"/g, (quoted, name) => ability(names.get(name)) === undefined ? quoted : '"Card"');
  },
};

function normalize(state) {
  const mappings = new Map();
  const players = Object.fromEntries(Object.entries(state.players).map(([name, player]) => {
    const slots = player.slots ?? {};
    const occupied = wonders.filter(slot => slots[slot]).sort((a, b) => slots[a] < slots[b] ? -1 : slots[a] > slots[b] ? 1 : 0);
    const ordered = [...occupied, ...wonders.filter(slot => !slots[slot])];
    const mapping = new Map(ordered.map((slot, index) => [slot, wonders[index]]));
    mappings.set(name, mapping);
    return [name, { ...player, slots: Object.fromEntries([
      ...Object.entries(slots).filter(([slot]) => !mapping.has(slot)),
      ...occupied.map(slot => [mapping.get(slot), slots[slot]]),
    ]) }];
  }));
  return { ...state, players, mappings };
}

function prepareMoves(state, physical, options) {
  const prompt = state.next_move_choice;
  if (!placements.has(prompt) && prompt !== 'Place card where?') return new Map(options.map(move => [move, move]));
  const actor = state.next_move_player;
  const player = physical.players[actor];
  const empty = wonders.slice(0, capacity(player.nation)).filter(slot => options.includes(slot) && !player.slots?.[slot]);
  const aliases = new Set(empty.slice(1));
  const firstEmpty = wonders.find(slot => !Object.hasOwn(state.players[actor].slots, slot));
  const mapping = state.mappings.get(actor);
  return new Map(options.filter(move => !aliases.has(move)).map(move => [
    empty.length && move === empty[0] ? firstEmpty : mapping.get(move) ?? move, move,
  ]));
}

function penalties(info) {
  return resources.map(r => info.penaltyResource === `Resource.${r.toUpperCase()}` ? (info.penalty ?? 0) / 15 : 0);
}

function profile(id) {
  const info = card(id), stages = info.stages ?? [];
  return [Number(Boolean(id)), ...oneHot(types, info.type), ...resources.map(r => (info.amounts?.[r] ?? 0) / 10),
    (info.points ?? 0) / 5, (info.deployCost ?? 0) / 5, (info.military ?? 0) / 40, (info.raid ?? 0) / 10,
    stages.length / 5, sum(stages) / 15, ...penalties(info)];
}

function progress(id, info = {}) {
  const complete = info.architects ?? 0;
  return [(info.deployed ?? 0) / 6, complete / 5, (card(id).stages?.[complete] ?? 0) / 5,
    (info.explored ?? 0) / 5, (info.exploration_turns ?? 0) / 5, (info.private ?? 0) / 3, (info.markers ?? 0) / 6,
    Number(Boolean(info.covered_by)), Number(Boolean(info.global)), ...resources.slice(0, 3).map(r => amount(info.resources, r) / 6)];
}

function playerProfile(player) {
  const held = player.cards ?? {}, active = Object.values(player.slots ?? {});
  return [Number(Object.hasOwn(player, 'resources')), amount(player.resources, 'Books') / 80,
    ...['SnTz', 'NcMc', 'GrWl', 'K_KK', 'K_JK'].map(id => Number(mixedFeatureRules.identity(id) && (Object.hasOwn(held, id) || active.includes(id)))),
    ...owned.flatMap(slot => {
      const id = player.slots?.[slot];
      return [...profile(id), ...progress(id, held[id])];
    })];
}

function playerAbilities(player) {
  const cards = player.cards ?? {};
  const active = abilityFlags(), building = abilityFlags(), global = abilityFlags();
  const pending = new Set();
  for (let id = player.slots?.Hire; id && !pending.has(id); id = cards[id]?.covered_by) pending.add(id);
  for (const id of new Set([...Object.keys(cards), ...Object.values(player.slots ?? {})])) {
    const index = ability(id);
    if (index === undefined || player.dynasties?.includes(id)) continue;
    if (pending.has(id)) building[index] = 1;
    else {
      active[index] = 1;
      global[index] = Number(Boolean(cards[id]?.global));
    }
  }
  return [...active, ...building, ...global];
}

function wonderCounts(player) {
  const total = capacity(player.nation);
  const occupants = wonders.map(slot => player.slots?.[slot]).filter(Boolean);
  const replaceable = occupants.filter(id => !['natural-wonder', 'extension'].includes(card(id).type)).length;
  return [total / 6, (total - occupants.length) / 6, replaceable / 6];
}

function actionProfile(state, move) {
  const player = state.players[state.next_move_player];
  const held = player.cards ?? {}, slots = player.slots ?? {};
  const draft = state.nations?.[move];
  const quantities = Object.fromEntries([...move.matchAll(/(-?\d+)\s+\[(Food|Stone|Gold|Books?|Military|Stability|Points?|Workers?)\]/g)].map(([, n, name]) => [name, Number(n)]));
  const quantity = name => quantities[name] ?? 0;
  let kind = 'other', target = '', price = 0, id;
  if (draft) kind = 'draft';
  else if (['Pass', 'Turmoil', 'Explore'].includes(move)) {
    kind = move.toLowerCase();
    if (kind === 'explore') id = Object.keys(held).find(id => Object.hasOwn(held[id], 'exploration_turns'));
  } else if (/^Buy P\d+$/.test(move)) {
    kind = 'buy'; target = move.slice(4); price = Number(target[1]); id = state.progress_board?.[target];
  } else if (/^(Deploy to |Undeploy from )/.test(move)) {
    kind = move.split(' ')[0].toLowerCase(); target = move.split(' ').at(-1); id = slots[target];
  } else if (placements.has(state.next_move_choice) && /^W[1-6]$/.test(move)) {
    target = move; id = slots[target];
  } else if (/^(Play|Special of|Buy) "/.test(move)) {
    kind = { Play: 'dynasty', Special: 'special', Buy: 'buy' }[move.split(' ')[0]];
    const name = move.split('"')[1];
    id = [...Object.keys(held), ...(player.dynasties ?? [])].find(key => card(key).name === name) ?? names.get(name);
  } else if (move === 'Hire' || move.startsWith('Hire from ')) {
    kind = 'hire'; target = 'Hire'; id = slots.Hire;
  } else {
    // The trained encoder inserts a Books quantity even for an empty menu item.
    kind = 'resources';
  }
  const [, group, slot = 0] = /^(BM|[ACSW])(\d+)$/.exec(target) ?? [];
  const flags = abilityFlags();
  for (const cid of [id, names.get(move), ...[...move.matchAll(/"([^"]+)"/g)].map(([, name]) => names.get(name))]) {
    const index = ability(cid);
    if (index !== undefined) flags[index] = 1;
  }
  return [...oneHot(actions, kind), ...oneHot(slotGroups.map(([prefix]) => prefix), group), slot / 6, price / 3,
    ...resources.map(r => (quantity(r) + (r === 'Books' ? quantity('Book') : 0)) / 10),
    (quantity('Worker') + quantity('Workers')) / 4, (quantity('Point') + quantity('Points')) / 4,
    ...profile(id), ...progress(id, held[id]), ...flags, ...oneHot(lincoln, id),
    ...korea.map(cid => Number(Object.values(draft?.slots ?? {}).includes(cid)))];
}

export const mixedPlacement = prompt => placements.has(prompt);

export function mixedFeatures(state, legal, prompts) {
  const normalized = normalize(state);
  const choices = prepareMoves(normalized, state, legal);
  const [actor, rival] = [state.next_move_player, Object.keys(state.players).find(name => name !== state.next_move_player)];
  const [own, other] = [normalized.players[actor], normalized.players[rival]];
  const offered = abilityFlags();
  for (const choice of normalized.next_move_options ?? []) {
    if (!choice.startsWith('Special of "')) continue;
    const index = ability(names.get(choice.split('"')[1]));
    if (index !== undefined) offered[index] = 1;
  }
  const market = state.progress_board ?? {};
  const allowances = state.growth_allowances ?? {};
  const stateNumbers = [
    ...oneHot(prompts, state.next_move_choice), ...penalties(card(state.war)),
    ...[own, other].map(player => state.war ? (amount(player.resources, 'Military') - (state.war_value ?? 0)) / 40 : 0),
    ...resources.map((r, index) => (amount(own.resources, r) - amount(other.resources, r)) / [20, 20, 20, 80, 40, 15][index]),
    ...playerProfile(own), ...playerProfile(other), ...marketSlots.flatMap(slot => profile(market[slot])),
    ...playerAbilities(own), ...playerAbilities(other), ...offered, own.passed_first ?? 0, other.passed_first ?? 0,
    ...wonderCounts(own), ...wonderCounts(other), (allowances[actor] ?? 0) / 4, (allowances[rival] ?? 0) / 4,
    Number(Boolean(state.weighted_card_draw)),
    ...[own, other].flatMap(player => {
      const active = Object.values(player.slots);
      return [...korea.map(id => Number(active.includes(id))),
        ...lincoln.map(id => Number(active.includes(id) || Object.hasOwn(player.cards ?? {}, id)))];
    }),
    ...marketSlots.flatMap(slot => oneHot(lincoln, market[slot])),
  ];
  // Training normalized placement choices in the full menu before removing
  // administrative choices. Sort just the canonical wonder slots.
  const sortedWonderMoves = [...choices.keys()].filter(move => wonders.includes(move)).sort();
  const needsSort = placements.has(state.next_move_choice) || state.next_move_choice === 'Place card where?';
  const moves = [...choices.keys()].map(move => needsSort && wonders.includes(move) ? sortedWonderMoves.shift() : move);
  return { state: normalized, choices, moves, stateNumbers, actionNumbers: move => actionProfile(normalized, move) };
}
