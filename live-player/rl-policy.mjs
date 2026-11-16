import { blake2b } from '@noble/hashes/blake2.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import cards from './card-index.json' with { type: 'json' };

const cardIndexHash = sha256(readFileSync(new URL('./card-index.json', import.meta.url)));
const resources = ['Food', 'Stone', 'Gold', 'Books', 'Military', 'Stability'];
const types = ['building', 'military', 'advisor', 'colony', 'wonder', 'natural-wonder', 'battle', 'golden-age', 'war'];
const prompts = new Set(['Draft which nation?', 'Take what for growth?', 'Which action?', 'Which benefit?', 'Play which dynasty?']);
const excluded = new Set(['UNDO', 'Resign', 'Confirm', 'Confirm and complete the turn now']);
const modelIdPattern = /^rl-[0-9a-f]{24}$/;
const buckets = 4096;
const embeddingSize = 24;
const layerShapes = [[buckets, 24, false], [buckets, 24, false], [64, 84], [48, 91], [64, 112], [1, 64], [32, 64], [1, 32]];
const weightBytes = 4 * layerShapes.reduce((size, [out, input, bias]) => size + out * (input + (bias === false ? 0 : 1)), 0);
const maxBytes = weightBytes + 2048;
const ids = new Map();
const card = id => Object.hasOwn(cards, id) ? cards[id] : {};
const tokenText = value => value == null ? 'None' : String(value);
const scaled = (value, scale) => Math.max(-3, Math.min(3, (value ?? 0) / scale));
const amount = (fields, resource) => fields?.[`[${resource}]`] ?? 0;
const sum = values => values.reduce((total, value) => total + value, 0);
const sortedEntries = object => Object.keys(object ?? {}).sort().map(key => [key, object[key]]);
export const isExperimentalModel = id => typeof id === 'string' && modelIdPattern.test(id);

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function tokenId(text) {
  if (ids.has(text)) return ids.get(text);
  const bytes = Buffer.from(blake2b(Buffer.from(text, 'utf8'), { dkLen: 8 }));
  const id = 1 + Number(bytes.readBigUInt64LE() % BigInt(buckets - 1));
  if (ids.size >= 50000) ids.clear();
  ids.set(text, id);
  return id;
}

function playerNumbers(player) {
  const owned = Object.values(player.slots ?? {}).map(id => card(id).type);
  return [
    ...resources.map(r => scaled(amount(player.resources, r), 20)),
    ...resources.map(r => scaled(amount(player.production, r), 10)),
    scaled(player.workers, 8), scaled(player.grown_workers, 8), scaled(player.points, 30),
    scaled(player.score, 40), scaled(player.passed, 1),
    ...types.map(type => scaled(owned.filter(value => value === type).length, 5)),
  ];
}

function cardNumbers(info) {
  return [scaled(info.age, 4), scaled(info.points, 5), scaled(info.deployCost, 5), scaled(info.military, 10),
    scaled(info.raid, 5), scaled(info.famine, 5), scaled(info.penalty, 10), scaled(info.privateArchitects, 3),
    scaled(info.goldenAgeBonus, 5), ...resources.map(r => scaled(info.amounts?.[r], 5)),
    ...types.map(type => Number(info.type === type)), scaled(sum(info.stages ?? []), 10), scaled(info.stages?.length, 4)];
}

function observation(state, moves) {
  const actor = state.next_move_player;
  const rival = Object.keys(state.players).find(name => name !== actor);
  const numbers = [scaled(state.round, 8), scaled(state.architects, 5), scaled(state.turmoil, 5),
    scaled(state.war_value, 15), Number(Boolean(state.war)), Number(state.player_order?.[0] === actor), scaled(moves.length, 20)];
  const tokens = [`prompt/${state.next_move_choice}`, `event/${tokenText(state.event)}`, `war/${tokenText(state.war)}`];
  for (const [role, name] of [['self', actor], ['rival', rival]]) {
    const player = state.players[name];
    numbers.push(...playerNumbers(player));
    tokens.push(`${role}/nation/${tokenText(player.nation)}`);
    for (const [slot, cid] of sortedEntries(player.slots)) {
      tokens.push(`${role}/slot/${slot}/${cid}`, `${role}/card/${cid}`, `${role}/deployed/${cid}/${player.cards?.[cid]?.deployed ?? 0}`);
    }
    for (const cid of player.dynasties ?? []) if (cid) tokens.push(`${role}/dynasty/${cid}`);
  }
  for (const [slot, cid] of sortedEntries(state.progress_board)) tokens.push(`market/${slot}/${cid}`);
  for (const nation of Object.keys(state.nations ?? {}).sort()) tokens.push(`available/${nation}`);
  numbers.push(scaled(card(state.event).famine, 5));
  if (tokens.length > 128) throw new Error('Position exceeds the experimental model feature capacity.');
  return [numbers, tokens];
}

function action(state, move) {
  const player = state.players[state.next_move_player];
  const prompt = state.next_move_choice;
  const draft = Object.hasOwn(state.nations ?? {}, move) ? state.nations[move] : null;
  let kind = 'other', cid, price = 0;
  if (draft) kind = 'draft';
  else if (/^Buy P\d+$/.test(move)) {
    kind = 'buy';
    const slot = move.slice(4);
    cid = state.progress_board?.[slot];
    price = Number(slot[1]);
  } else if (move.startsWith('Deploy to ') || move.startsWith('Undeploy from ')) {
    kind = move.startsWith('Undeploy') ? 'undeploy' : 'deploy';
    cid = player.slots?.[move.trim().split(/\s+/).at(-1)];
  } else if (prompt === 'Take what for growth?') kind = 'growth';
  else if (move.startsWith('Hire')) { kind = 'hire'; cid = player.slots?.Hire; }
  else if (move === 'Pass') kind = 'pass';
  else if (move === 'Turmoil') kind = 'turmoil';
  else if (move.startsWith('Play ')) {
    kind = 'dynasty';
    cid = player.dynasties?.find(id => id && move.includes(card(id).name ?? ''));
  } else if (move.startsWith('Special of ')) kind = 'special';
  const info = card(cid);
  const tokens = [`kind/${kind}`, `move/${move}`, `prompt-kind/${prompt}/${kind}`, `type/${tokenText(info.type)}`];
  if (cid) tokens.push(`card/${cid}`, `${kind}/card/${cid}`);
  if (draft) tokens.push(`nation/${move}`);
  const draftCards = Object.values(draft?.slots ?? {});
  const numbers = [scaled(price, 3), scaled(player.cards?.[cid]?.deployed, 5), Number(move.includes('[Worker]')),
    ...cardNumbers(info), ...playerNumbers(draft ?? {}), ...resources.map(r => Number(move.includes(`[${r}]`))),
    ...resources.map(r => scaled(sum(draftCards.map(id => card(id).amounts?.[r] ?? 0)), 8))];
  return [numbers, tokens];
}

function embed(weights, tokens) {
  const values = new Float32Array(embeddingSize);
  for (const text of tokens) {
    const offset = tokenId(text) * embeddingSize;
    for (let i = 0; i < values.length; i++) values[i] += weights[offset + i];
  }
  const divisor = Math.sqrt(Math.max(tokens.length, 1));
  return values.map(value => value / divisor);
}

function dense({ weights, bias, input, output }, values, activate = true) {
  const result = new Float32Array(output);
  for (let row = 0; row < output; row++) {
    let value = bias[row];
    for (let col = 0; col < input; col++) value += weights[row * input + col] * values[col];
    result[row] = activate ? Math.tanh(value) : value;
  }
  return result;
}

export function decodeExperimentalModel(bytes, expectedId) {
  if (bytes.length > maxBytes || bytes.length < weightBytes + 5) throw new Error('Invalid model size.');
  const hash = sha256(bytes);
  const id = `rl-${hash.slice(0, 24)}`;
  if (expectedId != null && id !== expectedId) throw new Error('Model checksum does not match its filename.');
  const headerLength = bytes.readUInt32LE(0);
  if (headerLength + 4 + weightBytes !== bytes.length) throw new Error('Invalid model dimensions.');
  const header = JSON.parse(bytes.subarray(4, 4 + headerLength).toString('utf8'));
  if (header.format !== 'nations-policy-v1' || header.card_index_sha256 !== cardIndexHash ||
      !Number.isSafeInteger(header.games) || header.games < 1 || !/^[a-f0-9]{64}$/.test(header.checkpoint_sha256)) {
    throw new Error('Model export is incompatible with this player.');
  }
  let offset = 4 + headerLength;
  const tensor = count => {
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++, offset += 4) values[i] = bytes.readFloatLE(offset);
    if (!values.every(Number.isFinite)) throw new Error('Model contains nonfinite weights.');
    return values;
  };
  const [stateEmbedding, actionEmbedding, context, move, policy, logit, value, valueLogit] = layerShapes.map(([output, input, bias]) => {
    const weights = tensor(output * input);
    return bias === false ? weights : { weights, bias: tensor(output), output, input };
  });
  return {
    id, label: `Experimental RL · ${header.games.toLocaleString('en-US')} games · ${hash.slice(0, 8)}`,
    hash, checkpointHash: header.checkpoint_sha256,
    rank(state) {
      if (!prompts.has(state.next_move_choice) || Object.keys(state.players ?? {}).length !== 2 ||
          !Object.hasOwn(state.players, state.next_move_player) || state.next_move_options?.some(option => option.startsWith('Confirm'))) return null;
      const choices = state.next_move_options?.filter(option => !excluded.has(option)) ?? [];
      if (!choices.length) return null;
      const [numbers, tokens] = observation(state, choices);
      const position = dense(context, Float32Array.from([...numbers, ...embed(stateEmbedding, tokens)]));
      const moves = choices.map(choice => {
        const [numeric, categorical] = action(state, choice);
        const candidate = dense(move, Float32Array.from([...numeric, ...embed(actionEmbedding, categorical)]));
        const hidden = dense(policy, Float32Array.from([...position, ...candidate]));
        return { move: choice, score: dense(logit, hidden, false)[0] };
      });
      const prediction = dense(valueLogit, dense(value, position), false)[0];
      if (!Number.isFinite(prediction) || moves.some(item => !Number.isFinite(item.score))) throw new Error('Invalid model prediction.');
      return { moves: moves.sort((a, b) => b.score - a.score), winProbability: 1 / (1 + Math.exp(-prediction)) };
    },
  };
}

export function experimentalModels(directory, warn = console.warn) {
  const cache = new Map();
  function scan() {
    if (!directory) return [];
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const found = [];
    const present = new Set();
    for (const entry of entries) {
      const id = entry.name.slice(0, -4);
      if (!entry.isFile() || !entry.name.endsWith('.nrl') || !isExperimentalModel(id)) continue;
      const path = join(directory, entry.name);
      present.add(id);
      try {
        const stat = statSync(path);
        const tag = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (cache.get(id)?.tag !== tag) {
          cache.set(id, { tag, model: null });
          if (stat.size > maxBytes) throw new Error('Invalid model size.');
          const model = decodeExperimentalModel(readFileSync(path), id);
          cache.set(id, { tag, model });
          console.log(`Validated experimental checkpoint ${id}, SHA256 ${model.hash}.`);
        }
        const model = cache.get(id).model;
        if (model) found.push(model);
      } catch (error) { warn(`Ignoring experimental checkpoint ${id}: ${error.message}`); }
    }
    for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
    return found;
  }
  return { scan, get: id => scan().find(model => model.id === id) };
}
