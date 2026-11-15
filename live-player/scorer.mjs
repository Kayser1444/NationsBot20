import cards from './card-index.json' with { type: 'json' };
import defaults from './default-weights.json' with { type: 'json' };
import { boundedResource, mostLeast } from './ranking.mjs';

const resources = ['Food', 'Gold', 'Stone', 'Books'];
const amount = (fields, name) => Number(fields?.[`[${name}]`] ?? 0);
const zeroPlayer = { resources: {}, production: {}, slots: {}, cards: {} };
const slotPattern = /^(BM|A|C|W|S)\d+$/;
const stock = (player, resource) => amount(player.resources, resource);
const output = (player, resource) => amount(player.production, resource);

export function validateModel(model) {
  if (model?.schemaVersion !== 1 || !model.weights) throw new Error('Unsupported model format.');
  for (const weights of [model.weights, ...Object.values(model.profiles ?? {})]) {
    for (const [name, value] of Object.entries(weights)) {
      if (!Object.hasOwn(defaults.weights, name) || !Number.isFinite(value) || Math.abs(value) > 100) {
        throw new Error(`Invalid weight: ${name}`);
      }
    }
  }
  for (const key of Object.keys(defaults.weights)) {
    if (!(key in model.weights)) throw new Error(`Missing weight: ${key}`);
  }
  return model;
}

export function weightsFor(model, playerCount) {
  const profile = String(playerCount === 2 ? 2 : playerCount === 5 && model.profiles?.['5'] ? 5 : 4);
  return { ...model.weights, ...model.profiles?.[profile] };
}

function context(state, username) {
  const player = state.players?.[username] ?? zeroPlayer;
  const rivals = Object.entries(state.players ?? {}).filter(([name]) => name !== username).map(([, p]) => p);
  const round = Math.max(1, state.round);
  const age = Math.ceil(round / 2);
  const market = Object.entries(state.progress_board ?? {}).map(([slot, id]) => ({ slot, id, card: cards[id] ?? {}, price: Number(slot[1]) }));
  const nextBooks = p => stock(p, 'Books') + output(p, 'Books') * (round % 2 === 1 ? 2 : 1);
  const bookContest = rivals.reduce((sum, rival) => sum + 1 / (1 + Math.abs(nextBooks(player) - nextBooks(rival)) / 4), 0);
  const target = { Food: (cards[state.event]?.famine ?? age) + 1, Gold: 4 + age, Stone: 2 + age * 3, Books: 0 };
  const scarcity = name => {
    if (name === 'Books') return 0.5 + bookContest * (round % 2 === 0 ? 0.7 : 0.25);
    const reserve = stock(player, name) + output(player, name);
    return Math.max(0.3, Math.min(2, target[name] / Math.max(1, reserve)));
  };
  return { state, username, player, rivals, round, age, market, target, scarcity,
    horizon: (9 - round) / 8, playerCount: rivals.length + 1 };
}

function featuresFor(option, ctx) {
  const { state, player, rivals, round, age, market, target, scarcity, horizon } = ctx;
  const features = {};
  const add = (name, value) => { if (value) features[name] = (features[name] ?? 0) + value; };
  const addResources = (values, multiplier = 1) => {
    for (const resource of resources) add(resource.toLowerCase(), (values?.[resource] ?? 0) * scarcity(resource) * multiplier);
  };
  const prodValue = values => resources.reduce((value, resource) => value + (values?.[resource] ?? 0) * scarcity(resource), 0);

  function eventDelta(resource, change) {
    if (!change) return;
    const event = cards[state.event];
    if (!event?.effects?.length) return;
    const nations = Object.values(state.players);
    const index = Object.keys(state.players).indexOf(ctx.username);
    const values = nations.map(p => boundedResource(resource, stock(p, resource)));
    const before = mostLeast(values);
    values[index] = boundedResource(resource, values[index] + change);
    const after = mostLeast(values);
    for (const effect of event.effects) {
      if (!effect.includes(`[${resource}]`)) continue;
      const most = /^Most \[/.test(effect);
      const least = /^Least \[/.test(effect);
      if (!most && !least) continue;
      const key = most ? 'most' : 'least';
      const delta = Number(after[key][index]) - Number(before[key][index]);
      if (!delta) continue;
      // These features encode membership changes. Exact card/event resolution
      // is always left to the engine.
      if (least) add('eventThreat', -delta);
      else add('eventBonus', delta);
    }
  }

  function immediate(values, multiplier = 1) {
    const stability = (values?.Stability ?? 0) * multiplier;
    const military = (values?.Military ?? 0) * multiplier;
    const beforeStability = stock(player, 'Stability');
    add('stability', stability);
    if (stability) {
      const after = beforeStability + stability;
      add('revolt', Number(beforeStability < 0) - Number(after < 0));
      add('books', Math.min(0, after) - Math.min(0, beforeStability));
      eventDelta('Stability', stability);
    }
    if (!military) return;
    const before = stock(player, 'Military');
    const after = before + military;
    const affordable = market.filter(item => item.card.type === 'colony' && item.price <= stock(player, 'Gold'));
    const reachable = affordable.map(item => item.card.military).filter(Number.isFinite);
    add('colonyThreshold', reachable.some(threshold => before < threshold && after >= threshold) ? 1 : 0);
    if (military > 0 && reachable.some(threshold => threshold > after)) {
      add('colonyProgress', Math.max(...reachable.filter(threshold => threshold > after).map(threshold => military / Math.max(1, threshold - before))));
    }
    if (state.war) {
      add('warThreshold', Number(after >= state.war_value) - Number(before >= state.war_value));
    }
    add('turnOrder', rivals.reduce((sum, rival) =>
      sum + Number(after > stock(rival, 'Military')) - Number(before > stock(rival, 'Military')), 0));
    add('idleMilitary', Math.min(40, after) - Math.min(40, before));
    eventDelta('Military', military);
  }

  function remove(slot) {
    const id = player.slots?.[slot];
    const card = cards[id];
    if (!id) return;
    const count = player.cards?.[id]?.deployed ?? 0;
    if (!card) { add('strandedWorkers', -count); return; }
    const workerCard = ['building', 'military'].includes(card.type);
    const copies = workerCard ? count : 1;
    add('replacementOutput', -Math.max(0, copies * prodValue(card.amounts)));
    add('strandedWorkers', -Math.max(0, count - Math.floor(stock(player, 'Stone') / Math.max(1, card.deployCost ?? 1))));
    add('redeploymentCost', -count * (card.deployCost ?? 1));
    add('futureProduction', -0.25 * Math.max(0, prodValue(card.amounts)) * (workerCard ? 1 : copies) * horizon);
    immediate(card.amounts, -copies);
  }

  function pendingPlacement(card) {
    let slots;
    if (['building', 'military'].includes(card.type)) {
      slots = [...new Set(['BM1', 'BM2', 'BM3', 'BM4', ...Object.keys(player.slots ?? {}).filter(slot => /^BM\d+$/.test(slot))])];
    } else if (card.type === 'advisor') {
      slots = [...new Set(['A1', ...Object.keys(player.slots ?? {}).filter(slot => /^A\d+$/.test(slot))])];
    } else return;
    // Evaluate the same placement subdecision we will make after purchase.
    // Keeping the individual vectors allows edits to change replacement value.
    const candidates = slots.map(slot => {
      const saved = { ...features };
      for (const key of Object.keys(features)) delete features[key];
      remove(slot);
      const result = { ...features };
      for (const key of Object.keys(features)) delete features[key];
      Object.assign(features, saved);
      return result;
    });
    return candidates;
  }

  const purchase = option.match(/^Buy (P[1-3]\d+)$/);
  if (purchase) {
    const item = market.find(item => item.slot === purchase[1]);
    if (!item) return { features };
    const { card, price } = item;
    add('purchaseCost', -price);
    add('urgency', rivals.some(r => !r.passed && stock(r, 'Gold') >= price &&
      stock(r, 'Military') >= (card.military ?? 0)) ? 1 : 0);
    const delayed = ['wonder', 'natural-wonder', 'building', 'military'].includes(card.type);
    add('victoryPoints', (card.points ?? 0) * (delayed ? 0.35 : 1));
    if (card.type === 'building' || card.type === 'military') {
      add(card.type, 1);
      const count = Math.min(Math.max(1, player.workers ?? 0), Math.floor(stock(player, 'Stone') / Math.max(1, card.deployCost ?? 1)));
      const bestExisting = Math.max(0, ...Object.values(player.slots ?? {}).map(id => {
        const old = cards[id];
        return old?.type === card.type ? prodValue(old.amounts) : 0;
      }));
      if (card.type === 'building') {
        const upgrade = Math.max(0, prodValue(card.amounts) - bestExisting);
        addResources(card.amounts, 0.35 * count);
        add('futureProduction', upgrade * horizon);
      } else if (count > 0) immediate(card.amounts, 0.6);
      if (!count) add('redeploymentCost', -(card.deployCost ?? 1));
      return { features, replacements: pendingPlacement(card) };
    }
    if (card.type === 'colony' || card.type === 'advisor') {
      add(card.type, 1);
      addResources(card.amounts);
      add('futureProduction', prodValue(card.amounts) * horizon);
      immediate(card.amounts);
      return { features, replacements: pendingPlacement(card) };
    }
    if (card.type === 'battle') {
      const raid = Math.max(0, ...Object.entries(player.cards ?? {})
        .filter(([, c]) => c.deployed).map(([id]) => cards[id]?.raid ?? 0));
      const resource = ['Food', 'Stone', 'Books'].toSorted((a, b) => scarcity(b) - scarcity(a))[0];
      addResources({ [resource]: raid });
    } else if (card.type === 'war') {
      const strength = Math.min(40, stock(player, 'Military'));
      const defeated = rivals.filter(r => stock(r, 'Military') < strength);
      add('warLoss', defeated.length / Math.max(1, rivals.length));
      add('eventThreat', rivals.some(r => !r.passed && stock(r, 'Military') >= strength) ? -0.25 : 0);
    } else if (card.type === 'wonder' || card.type === 'natural-wonder') {
      add('wonder', 1);
      const stages = card.stages ?? [2, 2, 2];
      const cost = stages.reduce((a, b) => a + b, 0);
      add('redeploymentCost', -cost * 0.25);
      add('futureProduction', prodValue(card.amounts) * horizon * 0.5);
    } else if (card.type === 'golden-age') {
      add('goldenAge', 1);
      addResources({ [card.offersBooks ? 'Books' : 'Stone']: 2 });
    }
    return { features };
  }

  const deployed = option.match(/^(Deploy to|Undeploy from) (.+)$/);
  if (deployed) {
    const [, action, slot] = deployed;
    const sign = action === 'Deploy to' ? 1 : -1;
    const card = cards[player.slots?.[slot]] ?? {};
    add('workerUse', sign);
    addResources(card.amounts, sign);
    add('futureProduction', prodValue(card.amounts) * horizon * sign);
    add('redeploymentCost', sign > 0 ? -(card.deployCost ?? 1) : -0.25);
    immediate(card.amounts, sign);
    const foodAfter = stock(player, 'Food') + output(player, 'Food') - (cards[state.event]?.famine ?? age);
    if (sign * (card.amounts?.Food ?? 0)) {
      add('shortage', Math.max(0, -foodAfter) - Math.max(0, -foodAfter - sign * card.amounts.Food));
    }
    return { features };
  }
  if (slotPattern.test(option)) { remove(option); return { features }; }
  if (option === 'Turmoil') {
    add('turmoil', 1);
    addResources({ Gold: 2 });
    immediate({ Stability: -2 });
    return { features };
  }
  if (option === 'Pass') {
    add('pass', 1);
    const passed = rivals.filter(r => r.passed).length;
    const width = ctx.playerCount >= 5 ? 2 : 1;
    if (passed < width) {
      add('earlyPass', 1);
      if (cards[state.event]?.effects?.some(effect => effect.startsWith('First to Pass'))) add('eventBonus', 1);
    }
    return { features };
  }
  if (option === 'Hire' || option.startsWith('Hire from ')) {
    const id = player.slots?.Hire;
    const card = cards[id] ?? {};
    const completed = player.cards?.[id]?.architects ?? 0;
    const stages = card.stages ?? [2, 2, 2];
    add('redeploymentCost', -(stages[completed] ?? 2));
    add('wonderCompletion', 1 / Math.max(1, stages.length - completed));
    const competition = rivals.some(r => r.slots?.Hire && !r.passed);
    add('architectUrgency', state.architects <= 2 && competition ? 1 : 0);
    if (completed + 1 >= stages.length) {
      add('victoryPoints', card.points ?? 0);
      addResources(card.amounts);
      add('futureProduction', prodValue(card.amounts) * horizon);
      immediate(card.amounts);
    }
    return { features };
  }

  if (state.next_move_choice === 'Draft which nation?') {
    const nation = state.nations?.[option];
    if (nation) {
      for (const resource of ['Gold', 'Stone', 'Food']) add('draftEconomy', amount(nation.resources, resource) * 0.15);
      const nationCards = Object.values(nation.slots).map(id => cards[id]).filter(Boolean);
      const economy = nationCards.filter(c => c.type === 'building').reduce((sum, c) => sum + prodValue(c.amounts), 0);
      add('draftEconomy', economy);
      const military = Math.max(0, ...nationCards.map(c => c.amounts?.Military ?? 0));
      add('draftMilitary', military * (market.some(item => item.card.type === 'colony') ? 1 : 0.2));
    }
    return { features };
  }

  const gains = [...option.matchAll(/([+-]?\d+) \[(Food|Stone|Gold|Books?|Stability|Military|Point)\]/g)];
  const isWorker = option.includes('[Worker]');
  if (gains.length) {
    const values = {};
    for (const [, text, raw] of gains) values[raw === 'Book' ? 'Books' : raw] = Number(text);
    const lose = /^(Pay|Lose|Prevent)/i.test(state.next_move_choice);
    const sign = lose ? -1 : 1;
    addResources(values, sign);
    immediate(values, sign);
    if (values.Point && option !== 'Buy 1 [Point]') add('victoryPoints', sign * values.Point);
  }
  if (isWorker) {
    add('workerGrowth', 0.4 + horizon);
    add('reserve', -(player.workers ?? 0));
  }
  if (option === 'Buy 1 [Point]') {
    add('victoryPoints', 1);
    add('purchaseCost', -age);
  }
  if (option.startsWith('Play "')) {
    const name = option.slice(6, -1);
    const card = (player.dynasties ?? []).map(id => cards[id]).find(c => c?.name === name);
    add('dynasty', 1);
    addResources(card?.amounts);
    add('futureProduction', prodValue(card?.amounts) * horizon);
    immediate(card?.amounts);
  }
  if (option.startsWith('Special of ') || option === 'Special Action') add('special', 1);

  if (/^\d+$/.test(option) && /(?:Pay|Lose) what portion/.test(state.next_move_choice)) {
    const resource = state.next_move_choice.match(/in \[(\w+)\]|as \[(\w+)\]/);
    if (resource) {
      const name = resource[1] ?? resource[2];
      const other = resources.filter(r => r !== name && stock(player, r) > 0);
      const alternative = other.length ? Math.min(...other.map(scarcity)) : 0;
      add(name.toLowerCase(), Number(option) * (alternative - scarcity(name)));
    }
  }
  if (option === 'Yes') {
    if (/^Hire (?:1 )?\[Architect\] for free\?$/.test(state.next_move_choice)) {
      // The engine can present an empty placement list if no wonder slot is
      // available. Decline optional hiring when completion cannot be placed.
      const slots = Object.entries(player.slots ?? {}).filter(([slot]) => /^W\d+$/.test(slot));
      const available = slots.length < 5 || slots.some(([, id]) =>
        cards[id] && !['natural-wonder', 'extension'].includes(cards[id].type));
      add('wonderCompletion', available ? 2 : -100);
    } else {
      const trade = state.next_move_choice.match(/^Pay (\d+) \[(\w+)\] to gain (\d+) \[(\w+)\]/);
      if (trade) addResources({ [trade[2]]: -Number(trade[1]), [trade[4]]: Number(trade[3]) });
    }
  }
  return { features };
}

function dot(features, weights) {
  return Object.entries(features).reduce((score, [key, value]) => score + value * (weights[key] ?? 0), 0);
}

export function rankMoves(state, username, model = defaults, explain = false) {
  const options = (state.next_move_options ?? []).filter(option => !/^(UNDO|Resign)$/i.test(option));
  if (!options.length) return [];
  const confirmation = options.includes('Confirm') ? 'Confirm'
    : options.includes('Confirm and complete the turn now') ? 'Confirm and complete the turn now' : null;
  if (confirmation) return [{ move: confirmation, score: 0, features: {} }];
  const ctx = context(state, username);
  const weights = weightsFor(model, ctx.playerCount);
  return options.map(move => {
    const { features, replacements } = featuresFor(move, ctx);
    const best = replacements?.toSorted((a, b) => dot(b, weights) - dot(a, weights))[0];
    if (best) for (const [name, value] of Object.entries(best)) features[name] = (features[name] ?? 0) + value;
    const result = { move, score: dot(features, weights) };
    if (explain) {
      result.features = features;
      result.contributions = Object.fromEntries(Object.entries(features).map(([name, value]) => [name, value * weights[name]]));
    }
    return result;
  }).sort((a, b) => b.score - a.score);
}

export function selectMove(state, username, model = defaults) {
  return rankMoves(state, username, model)[0]?.move ?? null;
}
