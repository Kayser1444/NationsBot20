import cards from './card-index.json' with { type: 'json' };
import { militarySpecials } from './predictor-effects.mjs';

const stock = (player, name) => player.resources?.[`[${name}]`] ?? 0;
const market = state => Object.entries(state.progress_board ?? {}).map(([slot, id]) => ({ slot, id, price: Number(slot[1]), card: cards[id] }));

// A bounded reachability search over known cards. Turns here are complete
// actions: buying and placing a card consumes one action, not two turns.
// It does not assume production can be collected before the round ends.
export function militaryPlans(state, username, targetSlot, { maxActions = 4, maxNodes = 500, includeSpecials = false } = {}) {
  const player = state.players?.[username];
  const target = market(state).find(item => item.slot === targetSlot);
  if (!player || player.passed || target?.card?.type !== 'colony') return { plans: [], exhausted: false };
  const initial = {
    stone: stock(player, 'Stone'), gold: stock(player, 'Gold'), workers: player.workers ?? 0,
    military: stock(player, 'Military'), slots: { ...player.slots }, deployed: Object.fromEntries(Object.entries(player.cards ?? {}).map(([id, c]) => [id, c.deployed ?? 0])),
    available: Object.fromEntries(Object.entries(state.progress_board ?? {})), actions: [],
    food: stock(player, 'Food'), markers: Object.fromEntries(Object.entries(player.cards ?? {}).map(([id,c])=>[id,c.markers??0])),
  };
  const queue = [initial], seen = new Set(), plans = [];
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (++visited > maxNodes) return { plans, exhausted: true };
    const node = queue[cursor];
    if (node.actions.length >= maxActions) continue;
    if (node.gold >= target.price && node.military >= target.card.military) {
      plans.push({ actions: [...node.actions, `Buy ${targetSlot}`], turns: node.actions.length + 1,
        stoneLeft: node.stone, goldLeft: node.gold - target.price, workersLeft: node.workers,
        military: node.military });
      // Only earliest plans are needed for deadlines; retain ties with different
      // costs and avoid pretending longer detours are equally urgent.
      continue;
    }
    if (plans.length && node.actions.length + 1 >= plans[0].turns) continue;
    const next = [];
    if (includeSpecials) for (const id of Object.values(node.slots)) {
      const special = militarySpecials[id];
      if (!special || node.food < special.foodCost || (node.markers[id]??0) >= special.maxMarkers) continue;
      next.push({ ...node, food:node.food-special.foodCost, military:node.military+special.military,
        markers:{...node.markers,[id]:(node.markers[id]??0)+1}, actions:[...node.actions,`Special of "${cards[id].name}"`] });
    }
    for (const [slot, id] of Object.entries(node.slots)) {
      const card = cards[id];
      if (card?.type !== 'military' || !(card.amounts?.Military > 0) || node.workers < 1 || node.stone < card.deployCost) continue;
      next.push({ ...node, stone: node.stone - card.deployCost, workers: node.workers - 1,
        military: node.military + card.amounts.Military,
        deployed: { ...node.deployed, [id]: (node.deployed[id] ?? 0) + 1 },
        actions: [...node.actions, `Deploy to ${slot}`] });
    }
    for (const item of market(state)) {
      if (item.card?.type !== 'military' || !(item.card.amounts?.Military > 0) || !node.available[item.slot] || node.gold < item.price) continue;
      for (const [slot, oldId] of Object.entries(node.slots)) {
        if (!/^BM\d+$/.test(slot)) continue;
        const old = cards[oldId], workers = node.deployed[oldId] ?? 0;
        next.push({ ...node, gold: node.gold - item.price, workers: node.workers + workers,
          military: node.military - workers * (old?.amounts?.Military ?? 0),
          slots: { ...node.slots, [slot]: item.id }, deployed: { ...node.deployed, [oldId]: 0, [item.id]: 0 },
          available: { ...node.available, [item.slot]: null }, actions: [...node.actions, `Buy ${item.slot}; place ${slot}`] });
      }
    }
    for (const child of next) {
      const key = JSON.stringify([child.stone, child.gold, child.workers, child.military, child.slots, child.deployed, child.available, child.food, child.markers]);
      if (!seen.has(key)) { seen.add(key); queue.push(child); }
    }
  }
  return { plans: plans.sort((a, b) => a.turns - b.turns || b.goldLeft - a.goldLeft || b.stoneLeft - a.stoneLeft), exhausted: false };
}

function deployment(state, username, move) {
  const slot = move.match(/^Deploy to (BM\d+)$/)?.[1];
  const player = state.players?.[username], card = cards[player?.slots?.[slot]];
  if (!card || !['building', 'military'].includes(card.type) || player.workers < 1 || stock(player, 'Stone') < card.deployCost) return null;
  const after = structuredClone(state), p = after.players[username];
  p.resources['[Stone]'] = stock(p, 'Stone') - card.deployCost;
  p.workers--;
  const id = p.slots[slot]; p.cards[id] = { ...p.cards[id], deployed: (p.cards[id]?.deployed ?? 0) + 1 };
  p.production ??= {};
  for (const [resource, amount] of Object.entries(card.amounts ?? {})) {
    const fields = ['Military', 'Stability'].includes(resource) ? p.resources : p.production;
    fields[`[${resource}]`] = (fields[`[${resource}]`] ?? 0) + amount;
  }
  return after;
}

export function colonyRaces(state, username, options) {
  const order = (state.player_order ?? Object.keys(state.players)).filter(name => !state.players[name]?.passed);
  const index = order.indexOf(username);
  if (index < 0) return [];
  const nextIndex = Math.max(0,order.indexOf(options?.nextPlayer??username));
  const cycle = [...order.slice(nextIndex), ...order.slice(0, nextIndex)];
  return market(state).filter(item => item.card?.type === 'colony').map(item => {
    const routes = Object.fromEntries(cycle.map((name, offset) => {
      const result = militaryPlans(state, name, item.slot, options), plan = result.plans[0];
      return [name, { plan: plan ?? null, earliestAction: plan ? offset + (plan.turns - 1) * cycle.length : null, exhausted: result.exhausted }];
    }));
    const rivals = cycle.filter(name => name!==username && routes[name].plan);
    const deadline = rivals.length ? Math.min(...rivals.map(name => routes[name].earliestAction)) : null;
    const own = routes[username];
    const deployments = (state.next_move_options ?? []).filter(move => move.startsWith('Deploy to ')).map(move => {
      const after = deployment(state, username, move);
      if (!after) return null;
      const result = militaryPlans(after, username, item.slot, options), plan = result.plans[0];
      const earliestAction = plan ? cycle.indexOf(username) + plan.turns * cycle.length : null;
      return { move, continuation: plan?.actions ?? null, earliestAction,
        beatsKnownRivalPlans: earliestAction !== null && (deadline === null || earliestAction < deadline),
        exhausted: result.exhausted };
    }).filter(Boolean);
    return { slot: item.slot, name: item.card.name, price: item.price, requiredMilitary: item.card.military,
      routes, rivalDeadline: deadline,
      beatsKnownRivalPlans: own.earliestAction !== null && (deadline === null || own.earliestAction < deadline), deployments };
  });
}

function traceBasicPlan(state, username, actions) {
  let after = structuredClone(state);
  for (const action of actions) {
    if (action.startsWith('Deploy to ')) { after = deployment(after, username, action); if (!after) return null; continue; }
    const buy = action.match(/^Buy (P\d+)(?:; place (BM\d+))?$/);
    const id = buy && after.progress_board[buy[1]], card = cards[id], p = after.players[username];
    if (!card || !['military', 'colony'].includes(card.type)) return null;
    p.resources['[Gold]'] = stock(p, 'Gold') - Number(buy[1][1]);
    delete after.progress_board[buy[1]];
    if (buy[2]) {
      const oldId = p.slots[buy[2]], old = cards[oldId], count = p.cards[oldId]?.deployed ?? 0;
      for (const [resource, value] of Object.entries(old?.amounts ?? {})) {
        const fields = ['Military', 'Stability'].includes(resource) ? p.resources : p.production;
        fields[`[${resource}]`] = (fields[`[${resource}]`] ?? 0) - count * value;
      }
      p.workers += count; delete p.cards[oldId];
      p.slots[buy[2]] = id; p.cards[id] = {};
    } else {
      for (const [resource, value] of Object.entries(card.amounts ?? {})) {
        const fields = ['Military', 'Stability'].includes(resource) ? p.resources : p.production;
        fields[`[${resource}]`] = (fields[`[${resource}]`] ?? 0) + value;
      }
    }
  }
  return after;
}

// Demonstrates whether Food must be acquired immediately, or can be produced
// on owned cards after the competitive opening. This is a feasible Food plan,
// not an optimal whole-round allocation or a prediction of the unknown event.
export function growthFoodCoverage(state, username, options) {
  if (state.next_move_choice !== 'Take what for growth?') return [];
  return (state.next_move_options ?? []).flatMap(move => {
    const gain = move.match(/^(\d+) \[(Food|Stone|Gold)\]$/);
    if (!gain) return [];
    const grown = structuredClone(state), p = grown.players[username];
    p.resources[`[${gain[2]}]`] = stock(p, gain[2]) + Number(gain[1]);
    return market(grown).filter(item => item.card?.type === 'colony').flatMap(target => {
      const route = militaryPlans(grown, username, target.slot, options).plans[0];
      if (!route) return [];
      const after = traceBasicPlan(grown, username, route.actions);
      if (!after) return [];
      const end = after.players[username];
      const buildings = Object.entries(end.slots).filter(([, id]) => cards[id]?.type === 'building' && cards[id].amounts?.Food > 0);
      let frontier = [{ state: after, actions: [] }], best = frontier[0];
      const food = node => stock(node.state.players[username], 'Food') + (node.state.players[username].production['[Food]'] ?? 0);
      for (let workers = 0; workers < Math.min(15, end.workers); workers++) {
        const next = [];
        for (const node of frontier) for (const [slot] of buildings) {
          const child = deployment(node.state, username, `Deploy to ${slot}`);
          if (child) next.push({ state: child, actions: [...node.actions, `Deploy to ${slot}`] });
        }
        if (!next.length) break;
        // At a fixed worker count only keep the best Food value for each Stone
        // budget; lower-Food allocations cannot improve this particular bound.
        const byStone = new Map();
        for (const node of next) {
          const stone = stock(node.state.players[username], 'Stone');
          if (!byStone.has(stone) || food(node) > food(byStone.get(stone))) byStone.set(stone, node);
          if (food(node) > food(best)) best = node;
        }
        frontier = [...byStone.values()];
      }
      const final = best.state.players[username];
      return [{ growth: move, colony: target.card.name, competitiveActions: route.actions,
        privateFoodActions: best.actions, foodBeforeFamine: food(best),
        knownFamine: state.event ? cards[state.event]?.famine ?? null : null,
        goldAfterProduction: stock(final, 'Gold') + (final.production['[Gold]'] ?? 0),
        stoneAfterProduction: stock(final, 'Stone') + (final.production['[Stone]'] ?? 0),
        note: 'Excludes other event effects, war, Books scoring and special abilities. Worker-growth options are not evaluated here.' }];
    });
  });
}

export function readPositionPlans(state, username, options) {
  let draft = null;
  if (state.next_move_choice === 'Draft which nation?') {
    draft = (state.next_move_options ?? []).filter(name => state.nations?.[name]).map(name => {
      const nation = structuredClone(state.nations[name]);
      nation.nation = name; nation.production = {};
      nation.cards = Object.fromEntries([...Object.values(nation.slots), ...(nation.dynasties ?? [])].map(id => [id, {}]));
      const position = { ...state, players: { ...state.players, [username]: nation }, next_move_options: [] };
      return { nation: name, colonies: colonyRaces(position, username, options),
        note: 'Current visible draft only; later picks, growth, dynasties and special actions can change these routes.' };
    });
  }
  return { player: username, decision: state.move_number, draft, colonies: draft ? [] : colonyRaces(state, username, options),
    growth: growthFoodCoverage(state, username, options),
    assumptions: [
      'Each counted action is a complete turn, including placement and confirmation.',
      'Search covers ordinary military deployments, military purchases and colony purchases using visible resources.',
      'Rivals can choose another strategy; a reachable purchase is a threat, not a prediction that they will make it.',
      'Special actions, dynasty effects, discounts and disruption are not simulated; these are candidate routes, not guarantees.',
      'No future events, cards or hidden seed are read.',
    ] };
}
