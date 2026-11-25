import { isMainAction } from './action-prompt.mjs';
import cards from './card-index.json' with { type: 'json' };
import rules from './predictor-rules.json' with { type: 'json' };
import learned from './human-baseline.json' with { type: 'json' };
import easy from './trained-weights.json' with { type: 'json' };
import { rankHumanMoves } from './human-policy.mjs';
import { rankMoves } from './scorer.mjs';
import { predictAction as predict } from './medium.mjs';
import { activeDynasty, dynastyId, turmoilChoice, applyBenefit } from './dynasty-effects.mjs';

const stock = (p, resource) => p.resources?.[`[${resource}]`] ?? 0;
const production = (p, resource) => p.production?.[`[${resource}]`] ?? 0;
const market = state => Object.entries(state.progress_board ?? {}).map(([slot, id]) => ({ slot, id, card: cards[id], price: Number(slot[1]) }));
const playerResources = ['Gold', 'Stone', 'Food', 'Books'];
const slotPattern = /^(BM|A|C|W|S)\d+$/;
const inertCards = new Set(['Mg_Stp']);

function predictAction(state, username, move) {
  const before = state.players[username];
  return predict(state, username, move).map(variation => {
    const after = variation.state.players[username];
    // Snapshot production already includes revolt loss. Recalculate its change
    // when an advisor or a worker changes Stability in the public projection.
    after.production['[Books]'] = production(after, 'Books')
      + Math.min(0, stock(after, 'Stability')) - Math.min(0, stock(before, 'Stability'));
    return variation;
  });
}

function militaryPotential(player) {
  let strength = stock(player, 'Military');
  if (!(player.workers > 0) || player.passed) return strength;
  for (const id of Object.values(player.slots ?? {})) {
    const card = cards[id];
    const rule = rules.cards[id];
    if (card?.type !== 'military' || stock(player, 'Stone') < card.deployCost) continue;
    if (rule?.maxWorkers && (player.cards[id]?.deployed ?? 0) >= rule.workerPoints.length) continue;
    strength = Math.max(strength, stock(player, 'Military') + (card.amounts?.Military ?? 0));
  }
  return strength;
}

function removeCard(player, slot) {
  const after = structuredClone(player);
  const id = after.slots[slot], card = cards[id];
  if (!id) return after;
  const deployed = after.cards[id]?.deployed ?? 0;
  const count = ['military', 'building'].includes(card?.type) ? deployed : 1;
  const stability = stock(after, 'Stability');
  after.resources = { ...after.resources };
  after.production = { ...after.production };
  for (const [resource, value] of Object.entries(card?.amounts ?? {})) {
    const fields = ['Stability', 'Military'].includes(resource) ? after.resources : after.production;
    fields[`[${resource}]`] = (fields[`[${resource}]`] ?? 0) - count * value;
  }
  after.production['[Books]'] = production(after, 'Books') + Math.min(0, stock(after, 'Stability')) - Math.min(0, stability);
  after.workers = (after.workers ?? 0) + deployed;
  const workerPoints = (rules.cards[id]?.workerPoints ?? []).slice(0, deployed).reduce((sum, value) => sum + value, 0);
  after.score = (after.score ?? after.points ?? 0) - workerPoints - (card?.points ?? 0);
  delete after.slots[slot]; delete after.cards[id];
  return after;
}

function placementValue(state, player, username) {
  let value = player.score ?? player.points ?? 0;
  for (const [resource, weight] of [['Gold', .55], ['Stone', .45], ['Food', .35], ['Books', .25]]) {
    value += weight * (production(player, resource) + .35 * stock(player, resource));
  }
  value += .35 * stock(player, 'Stability') + .20 * stock(player, 'Military');
  for (const id of Object.values(player.slots ?? {})) {
    if (inertCards.has(id)) continue;
    const card = cards[id];
    value += .25;
    if (!['building', 'military'].includes(card?.type)) continue;
    value += .18 * [...playerResources, 'Stability'].reduce((sum, resource) => sum + Math.max(0, card.amounts?.[resource] ?? 0), 0);
    if (card.type === 'military') value += .18 * (card.amounts?.Military ?? 0) + .12 * (card.raid ?? 0);
  }
  const strength = militaryPotential(player);
  const wars = market(state).filter(item => item.card?.type === 'war' && item.price <= stock(player, 'Gold'));
  const rivals = Object.entries(state.players).filter(([name]) => name !== username).map(([, rival]) => rival);
  const threatened = wars.length ? rivals.filter(rival => strength > militaryPotential(rival)).length : 0;
  if (threatened) value += Math.min(1.5, strength * .30) * threatened / rivals.length;
  return value;
}

function placementMoves(state, username) {
  if (!/^Place .* where\?$/.test(state.next_move_choice) || !state.next_move_options.every(move => slotPattern.test(move))) return [];
  const player = state.players[username];
  return state.next_move_options.map(move => {
    const id = player.slots?.[move];
    const displaced = player.cards?.[id]?.deployed ?? 0;
    const after = removeCard(player, move);
    return { move, score: placementValue(state, after, username) - .45 * displaced,
      reasons: [`Preserves ${militaryPotential(after)} reachable Military after replacing ${cards[id]?.name ?? 'an empty space'}.`] };
  }).sort((a, b) => b.score - a.score);
}

function privateArchitects(player) {
  return Object.entries(player.cards ?? {}).reduce((sum, [id, state]) => sum + (id === player.slots?.Hire ? 0 : state.private ?? 0), 0);
}

function reserve(player, resource) { return stock(player, resource) + production(player, resource); }
function reserveValue(amount, target, surplus) { return Math.min(amount, target) + Math.max(0, amount - target) * surplus; }

function workerTransfers(state, player, passScore, username) {
  if (player.workers || state.round >= 8 || passScore === undefined) return new Map();
  const age = Math.ceil(state.round / 2), goldTarget = 4 + age, stoneTarget = 2 + 3 * age;
  if (reserve(player, 'Gold') >= goldTarget) return new Map();
  const transfers = new Map();
  for (const move of state.next_move_options.filter(move => move.startsWith('Undeploy from '))) {
    const sourceSlot = move.slice('Undeploy from '.length), source = cards[player.slots[sourceSlot]];
    if (source?.type === 'military') continue;
    const released = predictAction(state, username, move)[0]?.state;
    if (!released) continue;
    for (const [slot, id] of Object.entries(player.slots)) {
      const target = cards[id];
      if (slot === sourceSlot || (target?.amounts?.Gold ?? 0) <= (source?.amounts?.Gold ?? 0)) continue;
      const deploy = `Deploy to ${slot}`;
      const after = predictAction(released, username, deploy)[0]?.state.players[username];
      if (!after || stock(after, 'Stability') < Math.min(0, stock(player, 'Stability')) || stock(after, 'Military') < stock(player, 'Military')) continue;
      const gold = reserveValue(reserve(after, 'Gold'), goldTarget, .35) - reserveValue(reserve(player, 'Gold'), goldTarget, .35);
      const stone = reserveValue(reserve(after, 'Stone'), stoneTarget, .15) - reserveValue(reserve(player, 'Stone'), stoneTarget, .15);
      const food = Math.min(0, reserve(after, 'Food')) - Math.min(0, reserve(player, 'Food'));
      const books = reserve(after, 'Books') - reserve(player, 'Books');
      const value = gold + .75 * stone + food + .4 * books;
      if (value < .85 || value <= (transfers.get(move)?.value ?? 0)) continue;
      transfers.set(move, { value, score: passScore + Math.min(.65, .28 * value), nextDeploy: deploy,
        reasons: [`Move a worker from ${source.name} to ${target.name} for ${reserve(after, 'Gold')} Gold and ${reserve(after, 'Stone')} Stone after production.`] });
    }
  }
  return transfers;
}

function recoverStability(state, player) {
  const deficit = -stock(player, 'Stability');
  if (deficit <= 0) return true;
  if (market(state).some(item => ['advisor', 'colony'].includes(item.card?.type) && item.price <= stock(player, 'Gold')
      && (item.card.amounts?.Stability ?? 0) >= deficit && (item.card.military ?? 0) <= stock(player, 'Military'))) return true;
  const sources = player.workers > 0 ? [0] : [];
  for (const [id, cardState] of Object.entries(player.cards ?? {})) {
    if (cards[id]?.type !== 'military' && cardState.deployed > 0) sources.push(cards[id]?.amounts?.Stability ?? 0);
  }
  return Object.values(player.slots ?? {}).some(id => cards[id]?.type === 'building' && stock(player, 'Stone') >= cards[id].deployCost
    && sources.some(lost => (cards[id].amounts?.Stability ?? 0) - lost >= deficit));
}

function turmoilPenalty(state, player, username, policy) {
  if (stock(player, 'Stability') >= 2) return null;
  if (activeDynasty(player) === 'Ps_SE') return null;
  const benefits = turmoilChoice(state, username);
  const benefit = rankHumanMoves(benefits, policy, easy)[0]?.move ?? rankMoves(benefits, username, easy)[0]?.move;
  const after = benefit ? applyBenefit(benefits, username, benefit) : null;
  if (!after || recoverStability(after, after.players[username])) return null;
  const newlyFunded = market(state).filter(item => item.card?.type === 'war' && !state.war && item.price > stock(player, 'Gold') && item.price <= stock(after.players[username], 'Gold'));
  const rivals = Object.entries(state.players).filter(([name]) => name !== username).map(([, rival]) => rival);
  const lead = rivals.some(rival => stock(player, 'Military') > militaryPotential(rival));
  const blocked = rivals.some(rival => !rival.passed && market(state).some(item => item.card?.type === 'war' && item.price <= stock(rival, 'Gold')));
  return { penalty: newlyFunded.length && lead && !blocked ? .25 : .80,
    reasons: [`Turmoil reduces Stability to ${stock(after.players[username], 'Stability')} with no ordinary recovery that keeps Military.`] };
}

function advisorMoves(state, player, username, rows, passScore) {
  const adjusted = new Map(), age = Math.ceil(state.round / 2), horizon = 1 + .35 * (8 - state.round);
  const originalColonies = new Set(market(state).filter(item => item.card?.type === 'colony' && item.price <= stock(player, 'Gold') && item.card.military <= stock(player, 'Military')).map(item => item.id));
  for (const row of rows) {
    const slot = row.move.match(/^Buy (P\d+)$/)?.[1], id = state.progress_board[slot], advisor = cards[id];
    if (advisor?.type !== 'advisor') continue;
    const variants = predictAction(state, username, row.move);
    if (!variants.length) continue;
    const variation = variants.sort((a, b) => placementValue(b.state, b.state.players[username], username) - placementValue(a.state, a.state.players[username], username))[0];
    const after = variation.state, own = after.players[username];
    const beforeAdvisors = Object.values(player.slots).filter(card => cards[card]?.type === 'advisor');
    const replaced = beforeAdvisors.some(card => !Object.values(own.slots).includes(card));
    const price = stock(player, 'Gold') - stock(own, 'Gold');
    const delta = resource => production(own, resource) - production(player, resource);
    const foodWeight = reserve(player, 'Food') < 2 ? .38 : .14;
    let value = horizon * (.55 * delta('Gold') + .35 * delta('Stone') + foodWeight * delta('Food') + .34 * delta('Books'));
    value -= price * (reserve(own, 'Gold') < 4 + age ? .42 : .18) + (replaced ? .30 : 0);
    const reasons = [];
    if (delta('Books') > 0) reasons.push(`${advisor.name} adds ${delta('Books')} Books per production.`);
    if (id === 'Ahz' && market(after).length >= 2) { value += .45; reasons.push('Alhazen can swap two cards on the progress board.'); }
    const denial = Object.entries(state.players).some(([name, rival]) => name !== username && !rival.passed && stock(rival, 'Gold') >= Number(slot[1]) && Object.values(rival.slots ?? {}).includes('Eg_OK'));
    if (denial) { value += .30; reasons.push('Denies Egypt another advisor for Old Kingdom.'); }
    let score = row.score + Math.min(.85, Math.max(0, .25 * value));
    if (!replaced && passScore !== undefined && value > .65 && reserve(own, 'Gold') >= 4 + age) score = Math.max(score, passScore + Math.min(.55, .25 * value));
    if (stock(own, 'Military') > stock(player, 'Military')) {
      const colonies = market(after).filter(item => item.card?.type === 'colony' && !originalColonies.has(item.id) && item.price <= stock(own, 'Gold') && item.card.military <= stock(own, 'Military'));
      let best = 0, target;
      for (const colony of colonies) {
        const contested = Object.entries(after.players).some(([name, rival]) => name !== username && !rival.passed && stock(rival, 'Gold') >= colony.price && stock(rival, 'Military') >= colony.card.military);
        if (contested) continue;
        const amounts = colony.card.amounts ?? {};
        const payoff = (colony.card.points ?? 0) + horizon * (.55 * (amounts.Gold ?? 0) + .35 * (amounts.Stone ?? 0) + .24 * (amounts.Food ?? 0) + .36 * (amounts.Books ?? 0)) - .18 * colony.price;
        if (payoff > best) { best = payoff; target = colony; }
      }
      if (target) { score += Math.min(2.4, .30 + .52 * best); reasons.push(`${stock(own, 'Military')} Military opens ${target.card.name} in the ${target.price}-Gold row.`); }
    }
    if (score > row.score) adjusted.set(row.move, { score, reasons });
  }
  return adjusted;
}

export function rankBaselineMoves(state, username = state.next_move_player, policy = learned) {
  const options = state.next_move_options ?? [];
  if (options.length <= 1 || options.some(move => move.startsWith('Confirm'))) return rankMoves(state, username, easy);
  const placements = placementMoves(state, username);
  if (placements.length) return placements;
  const learnedMoves = rankHumanMoves(state, policy, easy);
  if (!learnedMoves.length) return rankMoves(state, username, easy);
  if (state.next_move_choice === 'Which benefit?' && state.round === 8 && !(state.turmoil > 0)) {
    const gold = learnedMoves.find(row => row.move === '2 [Gold]');
    // Sassanid has no activation reward: with no remaining Gold turmoil now
    // or in a future round, taking the immediate Gold strictly dominates it.
    if (gold) return learnedMoves.map(row => dynastyId(state.players[username], row.move) === 'Ps_SE'
      ? { ...row, score: Math.min(row.score, gold.score - .01), reasons: ['No Gold turmoil remains before game end for Sassanid to improve.'] } : row).sort((a, b) => b.score - a.score);
  }
  if (!isMainAction(state.next_move_choice)) return learnedMoves;
  const player = state.players[username], passScore = learnedMoves.find(row => row.move === 'Pass')?.score;
  const transfers = workerTransfers(state, player, passScore, username);
  const advisors = advisorMoves(state, player, username, learnedMoves, passScore);
  const turmoil = options.includes('Turmoil') ? turmoilPenalty(state, player, username, policy) : null;
  let setup = 0, setupReason;
  if (options.includes('Turmoil') && (player.dynasties ?? []).some(Boolean)) {
    const benefits = turmoilChoice(state, username), ranked = rankHumanMoves(benefits, policy, easy);
    const best = ranked[0], gold = ranked.find(row => row.move === '2 [Gold]');
    if (best && dynastyId(player, best.move) && gold && best.score > gold.score) {
      setup = Math.min(.65, .20 * (best.score - gold.score));
      setupReason = `Opens ${best.move}, preferred to immediate Gold by the learned benefit policy.`;
    }
  }
  return learnedMoves.map(row => {
    const transfer = transfers.get(row.move);
    if (transfer && transfer.score > row.score) return { ...row, ...transfer };
    if (advisors.has(row.move)) return { ...row, ...advisors.get(row.move) };
    if (row.move === 'Turmoil' && (turmoil || setup)) return { ...row, score: row.score + setup - (turmoil?.penalty ?? 0), reasons: [...(turmoil?.reasons ?? []), ...(setupReason ? [setupReason] : [])] };
    const slot = row.move.match(/^Buy (P\d+)$/)?.[1], card = cards[state.progress_board?.[slot]];
    if (card?.type === 'wonder') {
      const needed = card.stages?.length ?? 0, available = (state.architects ?? 0) + privateArchitects(player);
      if (needed > available) return { ...row, score: row.score - Math.min(1.25, .38 * (needed - available) + .11 * Number(slot[1])) - (state.round === 8 ? 1 : 0),
        reasons: [`${card.name} needs ${needed} architects and only ${available} are available this round.`] };
    }
    return row;
  }).sort((a, b) => b.score - a.score);
}

export function chooseBaselineMove(state, context = {}) {
  if (context.transfer && isMainAction(state.next_move_choice)) {
    const planned = context.transfer;
    context.transfer = null;
    if (planned.decision === state.move_number && state.next_move_options.includes(planned.move)) return planned.move;
  }
  const first = rankBaselineMoves(state)[0];
  if (first?.nextDeploy) context.transfer = { move: first.nextDeploy, decision: state.move_number + 1 };
  return first?.move ?? null;
}
