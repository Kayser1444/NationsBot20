import cards from './card-index.json' with { type: 'json' };
import defaults from './default-specials.json' with { type: 'json' };
import { mostLeast, boundedResource } from './ranking.mjs';

// Printed ability categories from Tabony dynasty_cards.py. They are inputs to
// learning, not a table of dynasty preferences. Conditional forecasts below are
// bounded public-position estimates, not complete engine rollouts.
export const abilities = {
  Am_DR: ['forceDynasty', 'books'], Am_FP: ['buildingStone'],
  Ar_AC: ['rivalGoldenAgePoints'], Ar_UC: ['colonyDiscount'],
  C_MD: ['workerFood'], C_QD: ['workerArchitect'],
  Eg_NK: ['battleDiscount'], Eg_OK: ['advisorBooks'],
  Et_AK: ['marketGold'], Et_Sb: ['militaryUpkeep'],
  G_At: ['bookLeadGold'], G_St: ['singleMilitary'],
  I_Mg: ['wonderPoints'], I_My: ['growthWorkers'],
  J_EP: ['warImmunity', 'forbidColonies'], J_HP: ['goldenAgeBooks'],
  K_JK: ['resourceInvestment'], K_KK: ['warMilitary'],
  Mg_GH: ['rivalWarGold'], Mg_YD: ['immediateWorkers'],
  Ml_ME: ['advisorPoints'], Ml_SE: ['rivalFamine'],
  Pg_KL: ['warBattle'], Pg_PE: ['colonySpaces'],
  Pl_JD: ['extraFirstAction'], Pl_PLC: ['advisorSpaces'],
  Ps_AE: ['growthDeploy'], Ps_SE: ['discardGoldTurmoil'],
  R_RE: ['leadPointsBooks'], R_RR: ['architectStability'],
  Vk_Nm: ['raidBonus'], Vk_Vr: ['advisorPurchaseBooks'],
  Vn_DS: ['discardColonyPointsGold'], Vn_PW: ['rivalBattleColonyGold'],
};
const stock = (p, r) => p.resources?.[`[${r}]`] ?? 0;
const output = (p, r) => p.production?.[`[${r}]`] ?? 0;
export const activeDynasty = p => Object.values(p.slots ?? {}).find(id => cards[id]?.type === 'dynasty') ?? null;
export const currentSpecial = p => activeDynasty(p) ?? (defaults[p.nation] ?? []).find(c => Object.values(p.slots ?? {}).includes(c.id))?.id ?? 'none';
export function dynastyId(player, move) {
  return (player.dynasties ?? []).find(id => id && (move === cards[id]?.name || move === `Play "${cards[id]?.name}"`)) ?? null;
}

function most(state, who, resource, change = 0) {
  const names = Object.keys(state.players);
  const values = names.map(name => boundedResource(resource, stock(state.players[name], resource) + (name === who ? change : 0)));
  return mostLeast(values).most[names.indexOf(who)];
}

export function dynastyEffects(state, who, id) {
  const p = state.players[who], rounds = Math.max(0, 8 - state.round);
  const market = Object.entries(state.progress_board ?? {}).map(([slot, card]) => ({ card: cards[card], price: Number(slot[1]) }));
  const militaryWorkers = Object.entries(p.cards ?? {}).reduce((n, [card, s]) => n + (cards[card]?.type === 'military' ? s.deployed ?? 0 : 0), 0);
  const old = currentSpecial(p), oldDefault = (defaults[p.nation] ?? []).find(card => card.id === old);
  const features = { roundsLeft: rounds / 8, replacesDefault: Number(Boolean(oldDefault)), replacesDynasty: Number(Boolean(activeDynasty(p))) };
  for (const ability of abilities[id] ?? []) features[`ability/${ability}`] = 1;
  for (const [resource, value] of Object.entries(oldDefault?.resources ?? {})) features[`lost/${resource.slice(1, -1)}`] = value;
  features.lostPrivateArchitects = oldDefault?.privateArchitects ?? 0;
  if (id === 'Ps_SE') {
    features.stabilitySavedPerGoldTurmoil = 2;
    features.safeGoldUsesNow = Math.max(0, state.turmoil ?? 0) / 4;
    features.safeGoldUsesFuture = rounds / 8;
  }
  if (id === 'Ps_AE') features.futureGrowthDeployment = rounds / 8 * Math.max(0, ...Object.values(p.slots ?? {}).map(card => cards[card]?.deployCost ?? 0)) / 4;
  if (id === 'R_RE') {
    const militaryLoss = oldDefault?.resources?.['[Military]'] ?? 0;
    features.productionPoints = Number(most(state, who, 'Military', -militaryLoss) && most(state, who, 'Stability'));
    features.productionBooks = Number(!features.productionPoints && most(state, who, 'Stability')) * 2;
  }
  if (id === 'R_RR') features.stabilityFromArchitects = Math.min(state.architects ?? 0, Math.max(0, 2 - stock(p, 'Stability'))) / 3;
  if (id === 'G_St') features.militaryGain = militaryWorkers === 1 ? 4 : 0;
  if (id === 'K_KK') features.warDefense = militaryWorkers * 3;
  if (id === 'Mg_YD') { features.immediateWorkers = 3; features.foodReserve = (stock(p, 'Food') + output(p, 'Food')) / 5; }
  if (id === 'Ar_UC') features.newColonyAccess = market.filter(x => x.card?.type === 'colony' && x.price <= stock(p, 'Gold') && x.card.military > stock(p, 'Military') && x.card.military <= stock(p, 'Military') + 4).length;
  if (id === 'Vk_Nm') features.raidGain = 3;
  if (id === 'G_At') features.productionGold = most(state, who, 'Books') ? 3 : 0;
  if (id === 'Eg_NK') features.cheapBattles = market.filter(x => x.card?.type === 'battle').length;
  if (id === 'Eg_OK') features.advisorsForBooks = market.filter(x => x.card?.type === 'advisor' && x.price <= stock(p, 'Gold')).length + Object.values(p.slots ?? {}).filter(card => cards[card]?.type === 'advisor').length;
  if (id === 'J_EP') { features.warRiskRemoved = Math.max(0, (state.war_value ?? 0) - stock(p, 'Military')); features.coloniesForbidden = market.filter(x => x.card?.type === 'colony').length; }
  if (id === 'C_QD' || id === 'I_Mg') features.wonderStages = cards[p.slots?.Hire]?.stages?.length ?? 0;
  return features;
}

// These transitions are exact for the Sassanid turmoil cost and printed
// immediate resources. Other triggered abilities are represented as features.
export function turmoilChoice(state, who) {
  const next = structuredClone(state), p = next.players[who];
  next.turmoil--;
  if (activeDynasty(p) !== 'Ps_SE') {
    const stability = stock(p, 'Stability');
    p.turmoil = (p.turmoil ?? 0) + 1;
    p.resources['[Stability]'] = stability - 2;
    p.production['[Books]'] = output(p, 'Books') + Math.min(0, stability - 2) - Math.min(0, stability);
  }
  next.next_move_choice = 'Which benefit?';
  next.next_move_options = ['2 [Gold]', ...(p.dynasties ?? []).filter(Boolean).map(id => `Play "${cards[id].name}"`)];
  return next;
}

export function applyBenefit(state, who, move) {
  const next = structuredClone(state), p = next.players[who], id = dynastyId(p, move);
  if (!id) { if (move === '2 [Gold]') p.resources['[Gold]'] = stock(p, 'Gold') + 2; return next; }
  if (activeDynasty(p) === 'Ps_SE' && state.next_move_choice === 'Which benefit?') {
    const stability = stock(p, 'Stability');
    p.turmoil = (p.turmoil ?? 0) + 1; p.resources['[Stability]'] = stability - 2;
    p.production['[Books]'] = output(p, 'Books') + Math.min(0, stability - 2) - Math.min(0, stability);
  }
  const special = currentSpecial(p), old = cards[special] ?? (defaults[p.nation] ?? []).find(card => card.id === special);
  const values = old?.amounts ?? Object.fromEntries(Object.entries(old?.resources ?? {}).map(([r, n]) => [r.slice(1, -1), n]));
  for (const [resource, value] of Object.entries(values ?? {})) {
    const fields = ['Military', 'Stability'].includes(resource) ? p.resources : p.production;
    fields[`[${resource}]`] = (fields[`[${resource}]`] ?? 0) - value;
  }
  const slot = Object.keys(p.slots).find(slot => p.slots[slot] === special) ?? 'S1';
  delete p.cards[special]; p.slots[slot] = id; p.cards[id] = {};
  p.dynasties = p.dynasties.map(card => card === id ? null : card);
  if (id === 'Mg_YD') p.workers = (p.workers ?? 0) + 3;
  if (id === 'G_St' && Object.entries(p.cards).reduce((n, [card, s]) => n + (cards[card]?.type === 'military' ? s.deployed ?? 0 : 0), 0) === 1) p.resources['[Military]'] = stock(p, 'Military') + 4;
  return next;
}
