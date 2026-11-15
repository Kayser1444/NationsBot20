import cards from './card-index.json' with { type: 'json' };
import { rankMoves } from './scorer.mjs';

export const policyChoices = new Set(['Draft which nation?', 'Take what for growth?', 'Which action?']);
const amount = (fields, name) => fields?.[`[${name}]`] ?? 0;
const clip = (value, scale) => Math.max(-2, Math.min(2, value / scale));

function describe(state, player, move) {
  const purchase = move.match(/^Buy (P\d+)$/);
  if (purchase) {
    const id = state.progress_board[purchase[1]];
    return { kind: 'buy', id, price: Number(purchase[1][1]) };
  }
  const deployment = move.match(/^(Deploy to|Undeploy from) (\w+)$/);
  if (deployment) return { kind: deployment[1] === 'Deploy to' ? 'deploy' : 'undeploy', id: player.slots?.[deployment[2]] };
  if (state.nations?.[move]) return { kind: 'draft', nation: move };
  if (state.next_move_choice === 'Take what for growth?') {
    const worker = move.includes('[Worker]');
    const resource = move.match(/\[(Food|Stone|Gold|Stability)\]/)?.[1] ?? 'free';
    return { kind: 'growth', label: worker ? `worker/${resource}` : resource };
  }
  if (move === 'Hire' || move.startsWith('Hire from ')) return { kind: 'hire', id: player.slots?.Hire };
  if (move.startsWith('Special of ')) return { kind: 'special' };
  return { kind: move === 'Pass' ? 'pass' : move === 'Turmoil' ? 'turmoil' : 'other' };
}

// Only the current legal list and public position enter these vectors. The
// corpus's match ID, recorded choice and final rank never enter this function.
export function humanCandidates(state, easyModel) {
  if (!policyChoices.has(state.next_move_choice)) return [];
  const who = state.next_move_player;
  const player = state.players[who];
  const rivals = Object.entries(state.players).filter(([name]) => name !== who).map(([, p]) => p);
  const round = state.round || 1;
  const size = rivals.length + 1;
  const position = state.player_order.indexOf(who);
  const activeRivals = rivals.filter(p => !p.passed);
  const market = Object.entries(state.progress_board).map(([slot, id]) => ({ price: Number(slot[1]), card: cards[id] }));
  const legal = rankMoves(state, who, easyModel, true);
  const legalPurchases = legal.filter(candidate => /^Buy P\d+$/.test(candidate.move)).length;
  return legal.map(row => {
    const info = describe(state, player, row.move);
    const own = info.nation ? state.nations[info.nation] : player;
    const card = cards[info.id];
    const type = card?.type ?? info.label ?? info.nation ?? '';
    const group = [info.kind, type].filter(Boolean).join('/');
    const features = [];
    const add = (key, value = 1) => { if (value && Number.isFinite(value)) features.push([key, value]); };
    add(group);
    add(`${size}p/${group}`);
    add(`round${round}/${group}`);
    add(`seat${position}/${group}`);
    if (own.nation && info.kind !== 'draft') add(`nation/${own.nation}/${group}`);
    if (info.id) add(`${info.kind}/card/${info.id}`);
    if (info.price) add(`${group}/price${info.price}`);
    for (const [key, value] of Object.entries(row.features ?? {})) add(`scorer/${info.kind}/${key}`, clip(value, 3));
    const gold = amount(own.resources, 'Gold');
    const stone = amount(own.resources, 'Stone');
    const food = amount(own.resources, 'Food') + amount(own.production, 'Food') - (cards[state.event]?.famine ?? 0);
    const military = amount(own.resources, 'Military');
    const stability = amount(own.resources, 'Stability');
    const numeric = {
      gold: clip(gold, 5), stone: clip(stone, 5), foodAfterProduction: clip(food, 5),
      goldProduction: clip(amount(own.production, 'Gold'), 4), stoneProduction: clip(amount(own.production, 'Stone'), 5),
      workers: clip(own.workers ?? 0, 4), military: clip(military, 6), stability: clip(stability, 4),
      activeRivals: clip(activeRivals.length, 2), warDeficit: state.war ? clip(Math.max(0, state.war_value - military), 5) : 0,
      occupied: clip(player.cards?.[info.id]?.deployed ?? 0, 3),
      legalPurchases: clip(legalPurchases, 5),
    };
    for (const [name, value] of Object.entries(numeric)) add(`${group}/${name}`, value);
    const trainingMilitary = card?.amounts?.Military ?? Math.max(0, ...Object.values(own.slots ?? {}).map(id => cards[id]?.amounts?.Military ?? 0));
    if (info.kind === 'draft' || info.kind === 'deploy' && card?.type === 'military') {
      const targets = market.filter(item => item.card?.type === 'colony' && item.price <= gold && military < item.card.military);
      add(`${info.kind}/opensColony`, Number(targets.some(item => military + trainingMilitary >= item.card.military)));
      if (info.kind === 'draft') add('draft/startsWithMilitary', clip(trainingMilitary, 3));
    }
    return { move: row.move, features };
  });
}

export function rankHumanMoves(state, model, easyModel) {
  const rows = humanCandidates(state, easyModel);
  const legalOrder = new Map(state.next_move_options?.map((move, index) => [move, index]));
  return rows.map(({ move, features }) => ({ move, score: features.reduce((sum, [key, value]) =>
    sum + value * (Object.hasOwn(model.weights, key) ? model.weights[key] : 0), 0) }))
    .sort((a, b) => b.score - a.score || legalOrder.get(a.move) - legalOrder.get(b.move));
}
