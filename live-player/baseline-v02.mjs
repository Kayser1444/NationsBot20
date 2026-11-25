import { isMainAction } from './action-prompt.mjs';
import cards from './card-index.json' with { type: 'json' };

const resources = ['Food', 'Gold', 'Stone', 'Books'];
const amount = (fields, name) => Number(fields?.[`[${name}]`] ?? 0);
const cell = option => option.match(/^Buy (P[1-3]\d)$/)?.[1];
const deploy = option => option.match(/^Deploy to (.+)$/)?.[1];
const placement = /^[ACSW]\d+$|^BM\d+$/;

function economy(state, player, rival) {
  const round = state.round || 1;
  const age = Math.ceil(round / 2);
  const reserve = name => amount(player.resources, name) + amount(player.production, name);
  const gap = Math.abs(reserve('Books') - amount(rival.resources, 'Books') - amount(rival.production, 'Books'));
  return {
    Food: reserve('Food') <= 3 ? 1.35 : 0.4,
    Gold: reserve('Gold') < 4 + age ? 1.5 : 0.8,
    Stone: reserve('Stone') < Math.max(2 + 3 * age, player.workers ?? 0) ? 1.6 : 0.85,
    Books: (round % 2 === 0 && gap <= 4 ? 0.8 : 0.35) + (age >= 3 ? 0.25 : 0),
  };
}

function productionValue(output, weights) {
  return resources.reduce((value, resource) => value + weights[resource] * (output?.[resource] ?? 0), 0);
}

function replacementCost(player, slot, weights, state) {
  const id = player.slots?.[slot];
  if (!id) return 0;
  const card = cards[id];
  const inUse = player.cards?.[id]?.deployed ?? 0;
  if (!card) return 1 + 2 * inUse;
  const workerCard = card.type === 'building' || card.type === 'military';
  const copies = workerCard ? inUse : 1;
  const stability = amount(player.resources, 'Stability');
  const military = amount(player.resources, 'Military');
  const losesStability = stability >= 0 && stability - copies * (card.amounts?.Stability ?? 0) < 0;
  const losesWar = state.war && military >= state.war_value
    && military - copies * (card.amounts?.Military ?? 0) < state.war_value;
  const lostOutput = Math.max(0, copies * productionValue(card.amounts, weights));
  const boardValue = workerCard ? 0.25 * Math.max(0, productionValue(card.amounts, weights)) : 0;
  return 0.25 + boardValue + 1.5 * lostOutput + inUse * (0.75 + 0.4 * (card.deployCost ?? 1))
    + (losesStability ? 6 : 0) + (losesWar ? 6 : 0);
}

// The server supplies the complete legal options. This baseline evaluates the
// visible position without reconstructing unrevealed decks or simulating cards.
export function chooseMove(state, username, opponent) {
  const options = state.next_move_options.filter(option => !/^(undo|resign)$/i.test(option));
  if (!options.length || /^Are you sure you want to resign/i.test(state.next_move_choice)) return null;
  if (options.includes('Confirm')) return 'Confirm';
  if (options.includes('Confirm and complete the turn now')) return 'Confirm and complete the turn now';
  if (options.length === 1) return options[0];

  const player = state.players[username];
  const rival = state.players[opponent];
  const weights = economy(state, player, rival);
  const valueOf = output => productionValue(output, weights);
  const slotCost = slot => replacementCost(player, slot, weights, state);
  if (state.next_move_choice === 'Place card where?' && options.every(option => placement.test(option))) {
    return options.toSorted((a, b) => slotCost(a) - slotCost(b))[0];
  }
  if (state.next_move_choice === 'Take which resources?' || state.next_move_choice === 'Take which benefit?') {
    const valueOfGain = option => {
      const match = option.match(/^(\d+) \[(Food|Gold|Stone|Books?)\]$/);
      if (!match) return 0;
      const resource = match[2] === 'Book' ? 'Books' : match[2];
      return Number(match[1]) * weights[resource];
    };
    return options.toSorted((a, b) => valueOfGain(b) - valueOfGain(a))[0];
  }
  if (state.next_move_choice === 'Take what for growth?') {
    return options
      .map(option => {
        const match = option.match(/^(\d+) \[(Food|Gold|Stone)\]$/);
        return { option, score: match ? Number(match[1]) / (1 + amount(player.resources, match[2])) : 0 };
      })
      .sort((a, b) => b.score - a.score)[0].option;
  }
  if (!isMainAction(state.next_move_choice)) return options[0];

  const military = amount(player.resources, 'Military');
  const stability = amount(player.resources, 'Stability');
  const gold = amount(player.resources, 'Gold');
  const stone = amount(player.resources, 'Stone');
  const market = Object.entries(state.progress_board ?? {});
  const raid = Math.max(0, ...Object.entries(player.cards ?? {})
    .map(([id, card]) => card.deployed ? cards[id]?.raid ?? 0 : 0));
  // Every standard board has at least four building/military spaces. Include
  // visible extra spaces and let Tabony supply the actual placement options.
  const buildingSlots = new Set(['BM1', 'BM2', 'BM3', 'BM4',
    ...Object.keys(player.slots ?? {}).filter(slot => /^BM\d+$/.test(slot))]);
  const bestBuildingSlot = Math.min(...[...buildingSlots].map(slotCost));

  function militaryUse(output) {
    const after = military + (output?.Military ?? 0);
    if (state.war && military < state.war_value && after >= state.war_value) return 6;
    if (market.some(([place, id]) => {
      const threshold = cards[id]?.military;
      return Number(place[1]) <= gold && military < threshold && threshold <= after;
    })) return 5;
    return 0;
  }

  function stabilityValue(output) {
    const delta = output?.Stability ?? 0;
    if (delta < 0 && stability + delta < 0) return -6;
    if (stability < 0 && stability + delta >= 0) return 6;
    return 0.5 * delta;
  }

  function score(option) {
    const target = cell(option);
    if (target) {
      const price = Number(target[1]);
      const card = cards[state.progress_board[target]] ?? {};
      if (card.type === 'war') return -1;
      const threatened = !rival.passed && amount(rival.resources, 'Gold') >= price
        && amount(rival.resources, 'Military') >= (card.military ?? 0);
      if (card.type === 'colony') return 7 + Number(threatened);
      if (card.type === 'battle') return 3 + raid - price + Number(threatened);
      if (card.type === 'military') {
        const usage = militaryUse(card.amounts);
        if (!usage || !player.workers || stone < (card.deployCost ?? 1)) return -1;
        return usage + stabilityValue(card.amounts) - price - bestBuildingSlot;
      }
      if (card.type === 'building') {
        return 2.25 + valueOf(card.amounts) + stabilityValue(card.amounts) - 0.7 * price
          - bestBuildingSlot - (stone < (card.deployCost ?? 1) ? 1 : 0);
      }
      return 4 + Number(threatened) - 0.5 * price;
    }
    const slot = deploy(option);
    if (slot) {
      const card = cards[player.slots?.[slot]];
      if (!card) return -1;
      const output = card.amounts ?? {};
      if (card.type === 'military') {
        const usage = militaryUse(output);
        return (usage || -1) + stabilityValue(output);
      }
      return 1 + valueOf(output) + stabilityValue(output) - 0.25 * (card.deployCost ?? 1);
    }
    if (option === 'Hire' || option.startsWith('Hire from ')) return 5;
    if (option === 'Turmoil' && !player.turmoil && gold < 2 && stability >= 2) return 2;
    return option === 'Pass' ? 0 : -1;
  }

  return options.map(option => ({ option, score: score(option) }))
    .sort((a, b) => b.score - a.score)[0].option;
}
