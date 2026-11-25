import { policyPrompt } from './action-prompt.mjs';
import cards from './card-index.json' with { type: 'json' };
import { rankMoves } from './scorer.mjs';
import { colonyRaces } from './position-reader.mjs';
import { mostLeast } from './ranking.mjs';
import { militarySpecials } from './predictor-effects.mjs';
import rules from './predictor-rules.json' with { type: 'json' };
import { turmoilChoice, applyBenefit } from './dynasty-effects.mjs';

// Public-position surrogate, deliberately independent of the replay seed/decks.
// Engine legality remains authoritative. Bespoke card hooks are not reproduced;
// the search reports this limitation rather than claiming exact engine rollouts.
const amount = (p, r) => p.resources?.[`[${r}]`] ?? 0;
const prod = (p, r) => p.production?.[`[${r}]`] ?? 0;
const set = (p, r, n) => { p.resources[`[${r}]`] = n; };
const ageOf = s => Math.ceil(Math.max(1, s.round) / 2);
const copy = s => structuredClone(s);
const market = s => Object.entries(s.progress_board ?? {}).map(([slot, id]) => ({ slot, id, card: cards[id], price: Number(slot[1]) }));
const famine = s => cards[s.event]?.famine ?? ageOf(s);
const confirmations = ['Confirm', 'Confirm and complete the turn now'];

function changeProduction(p, values, count = 1) {
  p.production ??= {}; p.resources ??= {};
  for (const [r, n] of Object.entries(values ?? {})) {
    if (r === 'Military' || r === 'Stability') set(p, r, amount(p, r) + n * count);
    else p.production[`[${r}]`] = prod(p, r) + n * count;
  }
}

function assignNation(s, who, nation) {
  const before = s.players[who], p = copy(s.nations[nation]);
  p.nation = nation; p.production = {}; p.cards = {}; p.passed = false;
  p.grown_workers = p.workers; p.resources['[Books]'] = amount(before, 'Books') || (s.first_round_player_order ?? s.player_order).indexOf(who) + 1;
  for (const id of [...Object.values(p.slots), ...(p.dynasties ?? [])]) {
    p.cards[id] = {};
    if (!['building', 'military', 'dynasty', 'special'].includes(cards[id]?.type)) changeProduction(p, cards[id]?.amounts);
  }
  s.players[who] = p; delete s.nations[nation];
  s.available_nations = (s.available_nations ?? []).filter(n => n !== nation);
}

function remove(p, slot) {
  const id = p.slots[slot], card = cards[id];
  if (!id) return;
  const deployed = p.cards[id]?.deployed ?? 0;
  changeProduction(p, card?.amounts, -(['building', 'military'].includes(card?.type) ? deployed : 1));
  p.workers += deployed; delete p.cards[id]; delete p.slots[slot];
}

function slotsFor(p, type) {
  if (['building', 'military'].includes(type)) {
    // Standard nation boards have four spaces; only add extra spaces explicitly
    // present on this nation (e.g. Japan). No fictitious BM5 on a four-slot board.
    return Array.from({length:rules.nations[p.nation]?.buildings_military??4},(_,i)=>`BM${i+1}`);
  }
  if (type === 'advisor') return [...new Set(['A1', ...Object.keys(p.slots).filter(k => /^A\d+$/.test(k))])];
  if (type === 'colony') {
    const all = [...new Set(['C1', 'C2', ...Object.keys(p.slots).filter(k => /^C\d+$/.test(k))])];
    const empty = all.find(k => !p.slots[k]); return empty ? [empty] : all;
  }
  return [];
}

function raid(p) {
  return Math.max(0, ...Object.entries(p.cards ?? {}).filter(([, c]) => c.deployed > 0).map(([id]) => cards[id]?.raid ?? 0));
}

function actions(s, who) {
  const p = s.players[who];
  if (!p?.nation || p.passed) return [];
  const moves = [];
  for (const item of market(s)) {
    const c = item.card;
    if (!c || item.price > amount(p, 'Gold') || (c.type === 'colony' && amount(p, 'Military') < c.military)
      || (c.type === 'battle' && !raid(p)) || (c.type === 'war' && (s.war || amount(p, 'Military') <= 0))) continue;
    if (['building', 'military', 'colony', 'advisor', 'wonder', 'battle', 'war'].includes(c.type)) moves.push(`Buy ${item.slot}`);
    else if (c.type === 'golden-age' && (c.offersBooks || c.offersStone)) moves.push(`Buy ${item.slot}`);
  }
  if ((p.workers ?? 0) > 0) for (const [slot, id] of Object.entries(p.slots)) {
    const c = cards[id];
    const rule=rules.cards[id];
    if (['building', 'military'].includes(c?.type) && amount(p, 'Stone') >= c.deployCost
      && (!rule?.maxWorkers || (p.cards[id]?.deployed??0)<rule.workerPoints.length)) moves.push(`Deploy to ${slot}`);
  }
  if (p.slots.Hire && s.architects > 0) {
    const c = cards[p.slots.Hire], completed = p.cards[p.slots.Hire]?.architects ?? 0;
    if (c?.stages && amount(p, 'Stone') >= c.stages[completed]) moves.push('Hire');
  }
  if (s.turmoil > 0) moves.push('Turmoil');
  for (const id of Object.values(p.slots)) {
    const effect = militarySpecials[id];
    if (effect && amount(p,'Food') >= effect.foodCost && (p.cards[id]?.markers??0) < effect.maxMarkers) moves.push(`Special of "${cards[id].name}"`);
  }
  moves.push('Pass'); return moves;
}

// A transition is a complete action: placement/reward subchoices and Confirm
// do not consume another player's turn. nextSteps is used by the actual local
// engine callback so it follows the placement evaluated by search.
export function predictAction(state, who, move) {
  const describe = () => {
    const slot=move.match(/^Buy (P\d+)$/)?.[1];
    if(slot)return `Buy ${cards[state.progress_board[slot]]?.name??slot} (${slot})`;
    const deploy=move.match(/^(Deploy to|Undeploy from) (BM\d+)$/);
    return deploy?`${deploy[1]} ${cards[state.players[who].slots[deploy[2]]]?.name??deploy[2]} (${deploy[2]})`:move;
  };
  const initial = () => copy(state), wrap = (s, steps = []) => ({ state: s, steps, line: `${who}: ${describe()}${steps.length ? ` → ${steps.join(' → ')}` : ''}` });
  if (state.nations?.[move]) { const s = initial(); assignNation(s, who, move); return [wrap(s)]; }
  if (state.next_move_choice === 'Take what for growth?') {
    const gain = move.match(/^(-?\d+) \[(Food|Gold|Stone|Stability)\]( \[Worker\])?$/);
    if (!gain && move !== '[Worker]') return [];
    const s = initial(), p = s.players[who];
    if (move.includes('[Worker]')) {
      p.workers++; p.grown_workers++;
      // Food growth is upkeep, not a subtraction from the stockpile.
      if (gain?.[2] === 'Food') p.production['[Food]'] = prod(p, 'Food') + Number(gain[1]);
      else if (gain) set(p, gain[2], amount(p, gain[2]) + Number(gain[1]));
    } else set(p, gain[2], amount(p, gain[2]) + Number(gain[1]));
    s.next_move_choice = 'Which action?'; return [wrap(s)];
  }
  const deploy = move.match(/^(Deploy to|Undeploy from) (BM\d+)$/);
  if (deploy) {
    const p = state.players[who], id = p.slots[deploy[2]], c = cards[id], sign = deploy[1] === 'Deploy to' ? 1 : -1;
    if (!['building', 'military'].includes(c?.type) || (sign > 0 && (!(p.workers > 0) || amount(p, 'Stone') < c.deployCost))
      || (sign < 0 && !(p.cards[id]?.deployed > 0))) return [];
    if(sign>0&&rules.cards[id]?.maxWorkers&&(p.cards[id]?.deployed??0)>=rules.cards[id].workerPoints.length)return [];
    const s = initial(), q = s.players[who]; q.workers -= sign;
    if (sign > 0) set(q, 'Stone', amount(q, 'Stone') - c.deployCost);
    q.cards[id] = { ...q.cards[id], deployed: (q.cards[id]?.deployed ?? 0) + sign }; changeProduction(q, c.amounts, sign);
    return [wrap(s)];
  }
  if (move === 'Pass') { const s = initial(); s.players[who].passed = true; return [wrap(s)]; }
  if (move === 'Turmoil') {
    if (!(state.turmoil > 0)) return [];
    return [wrap(applyBenefit(turmoilChoice(state, who), who, '2 [Gold]'), ['2 [Gold]'])];
  }
  const specialId = Object.values(state.players[who]?.slots??{}).find(id=>move===`Special of "${cards[id]?.name}"`);
  if (militarySpecials[specialId]) {
    const effect = militarySpecials[specialId], p=state.players[who];
    if (amount(p,'Food') < effect.foodCost || (p.cards[specialId]?.markers??0)>=effect.maxMarkers) return [];
    const s=initial(), q=s.players[who]; set(q,'Food',amount(q,'Food')-effect.foodCost); set(q,'Military',amount(q,'Military')+effect.military);
    q.cards[specialId]={...q.cards[specialId],markers:(q.cards[specialId]?.markers??0)+1}; return [wrap(s)];
  }
  if (move === 'Hire') {
    const p = state.players[who], id = p.slots.Hire, c = cards[id], completed = p.cards[id]?.architects ?? 0, cost = c?.stages?.[completed];
    if (!(state.architects > 0) || !Number.isFinite(cost) || amount(p, 'Stone') < cost) return [];
    const s = initial(), q = s.players[who]; s.architects--; set(q, 'Stone', amount(q, 'Stone') - cost);
    q.cards[id] = { ...q.cards[id], architects: completed + 1 };
    if (completed + 1 === c.stages.length) {
      const slot = ['W1', 'W2', 'W3', 'W4', 'W5'].find(k => !q.slots[k]);
      if (!slot) return []; delete q.slots.Hire; q.slots[slot] = id; changeProduction(q, c.amounts);
    }
    return [wrap(s)];
  }
  const buy = move.match(/^Buy (P\d+)$/), item = buy && market(state).find(i => i.slot === buy[1]);
  if (!item?.card || amount(state.players[who], 'Gold') < item.price) return [];
  const c = item.card, p = state.players[who];
  if (c.type === 'colony' && amount(p, 'Military') < c.military) return [];
  if (['building', 'military', 'colony', 'advisor'].includes(c.type)) return slotsFor(p, c.type).map(slot => {
    const s = initial(), q = s.players[who]; set(q, 'Gold', amount(q, 'Gold') - item.price); delete s.progress_board[item.slot];
    remove(q, slot); q.slots[slot] = item.id; q.cards[item.id] = {};
    if (['colony', 'advisor'].includes(c.type)) changeProduction(q, c.amounts);
    return wrap(s, [slot]);
  });
  if (c.type === 'wonder') {
    const s = initial(), q = s.players[who]; set(q, 'Gold', amount(q, 'Gold') - item.price); delete s.progress_board[item.slot];
    if (q.slots.Hire) delete q.cards[q.slots.Hire]; q.slots.Hire = item.id; q.cards[item.id] = { architects: 0 }; return [wrap(s)];
  }
  if (c.type === 'battle' && raid(p)) return ['Food', 'Stone', 'Books'].map(resource => {
    const s = initial(), q = s.players[who], n = raid(q); set(q, 'Gold', amount(q, 'Gold') - item.price); delete s.progress_board[item.slot];
    set(q, resource, amount(q, resource) + n); return wrap(s, [`${n} [${resource}]`]);
  });
  if (c.type === 'golden-age' && (c.offersBooks || c.offersStone)) {
    const resource = c.offersBooks ? 'Books' : 'Stone';
    const s = initial(), q = s.players[who];
    const bonus = Object.entries(q.slots).filter(([slot]) => slot !== 'Hire')
      .reduce((sum, [, id]) => sum + (cards[id]?.goldenAgeBonus ?? 0), 0);
    const gain = 2 + bonus;
    set(q, 'Gold', amount(q, 'Gold') - item.price);
    set(q, resource, amount(q, resource) + gain);
    delete s.progress_board[item.slot];
    return [wrap(s, [`${gain} [${resource}]`])];
  }
  if (c.type === 'war' && !state.war && amount(p, 'Military') > 0) {
    const s = initial(); set(s.players[who], 'Gold', amount(p, 'Gold') - item.price); delete s.progress_board[item.slot];
    s.war = item.id; s.war_value = amount(p, 'Military'); return [wrap(s)];
  }
  return [];
}

function playerValue(s, who, p = s.players[who]) {
  if (!p?.nation) return 0;
  const age = ageOf(s), remaining = Math.max(1, 9 - Math.max(1, s.round));
  const gold = amount(p, 'Gold') + prod(p, 'Gold'), stone = amount(p, 'Stone') + prod(p, 'Stone');
  const food = amount(p, 'Food') + prod(p, 'Food') - famine(s);
  // Present score + a discounted economy; stockpiles saturate. Food beyond a
  // modest reserve earns very little; deficits and negative Stability hurt.
  let v = (p.points ?? 0) + Math.max(0, amount(p, 'Books') + prod(p, 'Books')) / 5;
  for(const [slot,id]of Object.entries(p.slots)){
    if(slot==='Hire')continue;
    if(['colony','wonder','natural-wonder'].includes(cards[id]?.type))v+=cards[id].points??0;
    v+=(rules.cards[id]?.workerPoints??[]).slice(0,p.cards[id]?.deployed??0).reduce((a,b)=>a+b,0);
  }
  v += Math.min(4 + age, Math.max(0, gold)) * .38 + Math.max(0, Math.min(12, gold - 4 - age)) * .08;
  v += Math.min(2 + age * 3, Math.max(0, stone)) * .26 + Math.max(0, Math.min(12, stone - 2 - age * 3)) * .05;
  v += Math.min(3, Math.max(0, food)) * .16 - Math.max(0, -food) * 1.1;
  v += remaining * (.63 * Math.min(7, prod(p, 'Gold')) + .40 * Math.min(9, prod(p, 'Stone')));
  v += remaining * .12 * Math.min(8, Math.max(0, prod(p, 'Books')));
  v -= Math.max(0, -amount(p, 'Stability')) * (1 + remaining * .16);
  v += Math.min(3, Math.max(0, amount(p, 'Stability'))) * .12;
  // Next-round labour has value even when not yet deployed. Current round
  // deployment potential is evaluated separately by affordable private closure.
  v += Math.min(15, p.grown_workers ?? p.workers ?? 0) * Math.min(1, remaining / 8) * .5;
  if (s.war && amount(p, 'Military') < s.war_value) v -= 1.5 + .3 * (s.war_value - amount(p, 'Military'));
  const wonder = cards[p.slots.Hire];
  if (wonder?.stages) {
    const completed = p.cards[p.slots.Hire]?.architects ?? 0;
    const cost = wonder.stages.slice(completed).reduce((a, b) => a + b, 0);
    const affordable = Math.max(0, Math.min(1, (amount(p, 'Stone') + Math.max(0, prod(p, 'Stone'))) / Math.max(1, cost)));
    v += affordable * (completed / wonder.stages.length + .15) * ((wonder.points ?? 0) + remaining * .4);
  }
  return v;
}

// Optimistic private completion: affordable building deployments can be saved
// until the market race is over. It never spends future production. Passing
// disables it, so abandoning useful workers cannot look equally good.
function completePrivate(s, who) {
  let best = s.players[who];
  if (best?.passed || !best?.nation) return best;
  for (let i = 0; i < 12; i++) {
    let next = best, value = playerValue(s, who, best);
    for (const id of Object.values(best.slots ?? {})) {
      const c = cards[id];
      if (c?.type !== 'building' || !(best.workers > 0) || amount(best, 'Stone') < c.deployCost
        || (rules.cards[id]?.maxWorkers&&(best.cards[id]?.deployed??0)>=rules.cards[id].workerPoints.length)) continue;
      const child = { ...best, resources: { ...best.resources }, production: { ...best.production }, cards: { ...best.cards }, workers: best.workers - 1 };
      set(child, 'Stone', amount(child, 'Stone') - c.deployCost); changeProduction(child, c.amounts);
      child.cards[id] = { ...child.cards[id], deployed: (child.cards[id]?.deployed ?? 0) + 1 };
      const score = playerValue(s, who, child);
      if (score > value + 1e-6) { value = score; next = child; }
    }
    if (next === best) break; best = next;
  }
  return best;
}

function values(s, close = true) {
  const names = Object.keys(s.players), v = Object.fromEntries(names.map(who => [who, playerValue(s, who, close ? completePrivate(s, who) : s.players[who])]));
  // Relative Books rank and the actual five-player most/least membership rule.
  const strengths = names.map(who => Math.min(40, amount(s.players[who], 'Military')));
  const stability = names.map(who => Math.min(15, amount(s.players[who], 'Stability')));
  const militaryRanks = mostLeast(strengths), stabilityRanks = mostLeast(stability);
  for (const [i, who] of names.entries()) {
    const own = s.players[who], book = amount(own, 'Books') + prod(own, 'Books') * (s.round % 2 ? 2 : 1);
    v[who] += names.filter(other => other !== who && book > amount(s.players[other], 'Books') + prod(s.players[other], 'Books') * (s.round % 2 ? 2 : 1)).length * (s.round % 2 === 0 ? .8 : .4);
    v[who] += militaryRanks.most[i] ? .25 : 0;
    for (const effect of cards[s.event]?.effects ?? []) {
      const ranks = effect.includes('[Military]') ? militaryRanks : effect.includes('[Stability]') ? stabilityRanks : null;
      if (ranks && /^Most \[/.test(effect) && ranks.most[i]) v[who] += .6;
      if (ranks && /^Least \[/.test(effect) && ranks.least[i]) v[who] -= .8;
    }
  }
  return v;
}

function relative(v, who) {
  const others = Object.entries(v).filter(([name]) => name !== who).map(([, n]) => n);
  if (others.length === 1) return v[who] - others[0];
  // Expected pairwise standing rewards moving up every league place, rather
  // than only rewarding the leader. This is an estimate, not a win probability.
  return others.reduce((sum, n) => sum + 12 * Math.tanh((v[who] - n) / 12), 0) / Math.max(1, others.length);
}

function raceOptions(s, nextPlayer) {
  const bonus = Object.fromEntries(Object.keys(s.players).map(who => [who, 0]));
  for (const who of Object.keys(s.players)) {
    if (!s.players[who]?.nation || s.players[who].passed) continue;
    for (const race of colonyRaces({ ...s, next_move_options: [] }, who, { maxNodes: 100, maxActions: 3, includeSpecials: true, nextPlayer })) {
      const plan = race.routes[who]?.plan;
      if (!plan || !race.beatsKnownRivalPlans) continue;
      const c = cards[s.progress_board[race.slot]], rounds = Math.max(1, 9 - Math.max(1, s.round));
      // Discount a feasible, uncontested future colony by the turns and labour
      // it consumes. Once bought, its actual output replaces this option value.
      const output = .63 * (c.amounts?.Gold ?? 0) + .40 * (c.amounts?.Stone ?? 0) + .15 * (c.amounts?.Food ?? 0);
      bonus[who] = Math.max(bonus[who], Math.max(0, rounds * output - race.price * .38) * .65 / plan.turns);
    }
  }
  return bonus;
}
function leafValue(s, who, nextPlayer=who) {
  const v = values(s), options = raceOptions(s,nextPlayer);
  for (const name of Object.keys(v)) v[name] += options[name];
  return relative(v, who);
}

function successors(s, who, moves, limit = 8) {
  const result = [];
  for (const move of moves) for (const child of predictAction(s, who, move)) result.push({ ...child, move, heuristic: relative(values(child.state), who) });
  const sorted = result.sort((a, b) => b.heuristic - a.heuristic), selected = sorted.slice(0, limit);
  // Military preparation can have a poor immediate leaf value. Keep the first
  // step of each feasible colony route in the beam even when Easy would prune it.
  for (const race of colonyRaces({ ...s, next_move_options: [] }, who, { maxNodes: 100, maxActions: 3, includeSpecials: true })) {
    const first = race.routes[who]?.plan?.actions[0]?.split(';')[0];
    const candidate = sorted.find(n => n.move === first);
    if (candidate && !selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

// Rival reply policy considers immediate state value plus the existing bounded
// colony predictor. This includes military preparation, not just legal buys.
function rivalReplies(s, who, width) {
  const candidates = successors(s, who, actions(s, who), 12);
  const races = colonyRaces({ ...s, next_move_options: actions(s, who) }, who, { maxNodes: 100, maxActions: 3, includeSpecials: true });
  const selected = candidates.slice(0, 1);
  for (const race of races) {
    if (!race.beatsKnownRivalPlans) continue;
    const first = race.routes[who]?.plan?.actions[0]?.split(';')[0];
    const candidate = candidates.find(n => n.move === first);
    if (candidate && !selected.includes(candidate)) selected.push(candidate);
  }
  return selected.slice(0, width);
}

function finishPublicDraft(state) {
  let s = state;
  for (const who of (state.player_order ?? Object.keys(state.players)).slice().reverse()) {
    if (s.players[who].nation) continue;
    const candidates = Object.keys(s.nations ?? {}).map(nation => {
      const after = copy(s);
      assignNation(after, who, nation);
      return { after, score: leafValue(after, who, after.player_order[0]) };
    });
    if (candidates.length) s = candidates.sort((a, b) => b.score - a.score)[0].after;
  }
  return s;
}

export function predictMoves(state, username, model, { depth = 3, maxNodes = 3000, timeMs = 2000, beamWidth = 2 } = {}) {
  // Local UI metadata, explanations and art URLs are not simulation inputs.
  state = Object.fromEntries(['players','nations','available_nations','progress_board','first_round_player_order','player_order','next_move_choice','next_move_player','next_move_options','round','move_number','event','war','war_value','architects','turmoil','game_over'].map(key=>[key,state[key]]));
  const started = performance.now(), deadline = started + Math.max(1, Math.min(5000, timeMs));
  depth = Math.max(1, Math.min(4, depth)); maxNodes = Math.max(1, Math.min(3000, maxNodes));
  const easy = rankMoves(state, username, model), legal = easy.map(row => row.move);
  const result = { method: 'public-position lookahead', depth, nodes: 0, completedDepth: 0, moves: [],
    assumptions: ['Visible cards and current round only; no replay seed or hidden decks.',
      'Basic purchases, placements, deployment, growth, draft, battles, wars, wonders and passing are modelled.',
      'Private building deployment is estimated at the leaf; bespoke card/nation hooks and new event resolution are not simulated.',
      'Rival replies are plausible threats, not a prediction of the human player.'], fallback: null };
  if (legal.length <= 1 || confirmations.includes(legal[0])) return { ...result, moves: easy, fallback: 'forced choice' };
  if (!['Which action?', 'Draft which nation?', 'Take what for growth?'].includes(policyPrompt(state.next_move_choice))) return { ...result, moves: easy, fallback: 'unmodelled subdecision uses Easy' };
  const roots = legal.flatMap(move => predictAction(state, username, move).map(child => ({ ...child, move, nextSteps: child.steps, plan: [child.line], root: move })));
  if (!roots.length) return { ...result, moves: easy, fallback: 'no modelled transitions' };
  const base = leafValue(state, username), order = state.player_order ?? Object.keys(state.players);
  const index = order.indexOf(username), rivals = [...order.slice(index + 1), ...order.slice(0, index)].filter(w => !state.players[w]?.passed);
  const earlyRivals = order.slice(0,index).filter(w => !state.players[w]?.passed);
  // Draft/growth do not reveal an actual future event. The same public board is
  // used to compare opening plans, with uncertainty explicitly retained.
  for (const root of roots) {
    if(state.next_move_choice==='Draft which nation?')root.state=finishPublicDraft(root.state);
    root.state.next_move_choice = 'Which action?';
    root.value = leafValue(root.state, username);
    root.score = root.value;
  }
  let bestByRoot = new Map();
  const budget = () => result.nodes < maxNodes && performance.now() < deadline;
  const exhausted = Symbol('search budget');
  function search(s, remaining, rivalIndex = 0, repliesToConsider = rivals) {
    if (!budget()) throw exhausted;
    result.nodes++;
    if (rivalIndex < repliesToConsider.length) {
      const who = repliesToConsider[rivalIndex], replies = rivalReplies(s, who, 2);
      if (!replies.length) return search(s, remaining, rivalIndex + 1, repliesToConsider);
      let worst = null;
      for (const reply of replies) {
        const continuation = search(reply.state, remaining, rivalIndex + 1, repliesToConsider);
        const candidate = { value: continuation.value, plan: [reply.line, ...continuation.plan] };
        if (!worst || candidate.value < worst.value) worst = candidate;
      }
      return worst;
    }
    if (remaining <= 1 || s.players[username].passed) return { value: leafValue(s, username), plan: [] };
    let best = null;
    for (const child of successors(s, username, actions(s, username), beamWidth)) {
      const continuation = search(child.state, remaining - 1);
      const candidate = { value: continuation.value, plan: [child.line, ...continuation.plan] };
      if (!best || candidate.value > best.value) best = candidate;
    }
    return best ?? { value: leafValue(s, username), plan: [] };
  }
  for (let ply = 1; ply <= depth && budget(); ply++) {
    const completed = new Map();
    try {
      for (const root of roots) {
        const continuation = search(root.state, ply, 0, policyPrompt(state.next_move_choice) === 'Which action?' ? rivals : earlyRivals);
        const candidate = { ...root, value: continuation.value, plan: [root.line, ...continuation.plan], searchedDepth: ply };
        if (!completed.has(root.move) || candidate.value > completed.get(root.move).value) completed.set(root.move, candidate);
      }
    } catch (error) { if (error !== exhausted) throw error; break; }
    // Commit only complete iterations. A timeout halfway through a deeper
    // comparison cannot favour whichever root happened to be searched first.
    bestByRoot = completed; result.completedDepth = ply;
  }
  // If the budget expires, all root choices still have a leaf evaluation. The
  // returned depth and per-row searchedDepth show how much search was completed.
  result.moves = legal.map(move => {
    const best = bestByRoot.get(move) ?? roots.filter(n => n.root === move).sort((a, b) => b.value - a.value)[0];
    return best ? { move, score: best.value - base, nextSteps: best.nextSteps, plan: best.plan, searchedDepth: best.searchedDepth ?? 0 }
      : { move, score: null, plan: [], searchedDepth: 0, unmodelled: true };
  }).sort((a, b) => {
    if (a.unmodelled || b.unmodelled) return Number(!!a.unmodelled) - Number(!!b.unmodelled);
    if (Math.abs(b.score - a.score) > 1e-6) return b.score - a.score;
    // Equal-valued growth plans retain flexible spending resources. A tied
    // Food reserve is not a reason to prefer Food over Gold automatically.
    const liquidity = row => {
      const p = roots.find(root => root.move === row.move)?.state.players[username];
      return p ? amount(p, 'Gold') + amount(p, 'Stone') * .5 : 0;
    };
    return liquidity(b) - liquidity(a);
  });
  result.duration_ms = performance.now() - started;
  return result;
}
