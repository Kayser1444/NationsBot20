import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeExperimentalModel, experimentalModels } from './rl-policy.mjs';
import { chooseMove } from './policy.mjs';
import { initialSettings, modelForSettings, settingsStore } from './settings.mjs';
import { createPlayerController } from './service.mjs';

function checkpoint(games) {
  const bytes = readFileSync(new URL('./card-index.json', import.meta.url));
  const header = Buffer.from(JSON.stringify({ format: 'nations-policy-v1', games,
    checkpoint_sha256: 'a'.repeat(64), card_index_sha256: createHash('sha256').update(bytes).digest('hex') }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(header.length);
  return Buffer.concat([prefix, header, Buffer.alloc(215874 * 4)]);
}

test('checkpoint checksum, dimensions, feature compatibility and legal action masking', () => {
  const bytes = checkpoint(10_000);
  const model = decodeExperimentalModel(bytes);
  assert.throws(() => decodeExperimentalModel(bytes, 'rl-' + 'b'.repeat(24)), /checksum/);
  assert.throws(() => decodeExperimentalModel(bytes.subarray(0, -1)), /dimensions/);
  const invalid = Buffer.from(bytes);
  invalid.writeFloatLE(Infinity, invalid.length - 4);
  assert.throws(() => decodeExperimentalModel(invalid), /nonfinite/);
  const state = { next_move_player: 'a', next_move_choice: 'Which action?', players: { a: {}, b: {} },
    player_order: ['a', 'b'], next_move_options: ['Pass', 'UNDO', 'Resign'] };
  assert.deepEqual(model.rank(state), { moves: [{ move: 'Pass', score: 0 }], winProbability: 0.5 });
  const configured = { ...modelForSettings({ ...initialSettings, twoPlayerModel: model.id }), experimental: model };
  assert.equal(chooseMove(state, 'a', 'b', configured), 'Pass');
  assert.equal(chooseMove({ ...state, next_move_choice: 'Confirm?', next_move_options: ['Confirm'] }, 'a', 'b', configured), 'Confirm');
  assert.equal(model.rank({ ...state, players: { ...state.players, c: {} } }), null);
});

test('a compatible upload appears without restarting and model versions stay pinned across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nations-rl-registry-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const install = games => {
    const bytes = checkpoint(games);
    const { id } = decodeExperimentalModel(bytes);
    writeFileSync(join(directory, `${id}.nrl`), bytes);
    return id;
  };
  const first = install(10_000);
  const settings = settingsStore(directory);
  const experiments = experimentalModels(directory);
  const game = matchId => ({ id: matchId, title: 'Fixture', playerCount: 2, players: ['Kayser', 'NationsBot20'] });
  const controls = [];
  let available = [game('9000')];
  const create = store => createPlayerController({ config: { username: 'NationsBot20', play: false, dataDir: directory },
    store, experiments, discover: async () => available, accept: async () => {}, connect: async config => {
      controls.push(config); return new Promise(resolve => config.signal.addEventListener('abort', () => resolve(true), { once: true }));
    } });
  const controller = create(settings);
  t.after(() => controller.close());
  assert.throws(() => controller.save({ ...initialSettings, multiplayerModel: first }, 0), /checkpoint/);
  assert.throws(() => controller.save({ ...initialSettings, twoPlayerModel: 'rl-' + 'c'.repeat(24) }, 0), /unavailable/);
  controller.save({ ...initialSettings, twoPlayerModel: first, maxConcurrentGames: 2 }, 0);
  await controller.poll();
  const second = install(20_000);
  assert.ok(controller.status().models.some(model => model.id === second && model.twoPlayerOnly));
  controller.save({ ...settings.read().settings, twoPlayerModel: second }, 1);
  assert.equal(controls[0].getModel().experimental.id, first);
  controller.close();
  const restarted = create(settingsStore(directory));
  t.after(() => restarted.close());
  available = [game('9000'), game('9001')];
  await restarted.poll();
  assert.equal(controls.findLast(config => config.matchId === '9000').getModel().experimental.id, first);
  assert.equal(controls.findLast(config => config.matchId === '9001').getModel().experimental.id, second);
  const actor = '229311536827465728';
  assert.throws(() => restarted.changeMatchModel({ matchId: '9000', modelId: second, previousModel: second }, actor), /Refresh/);
  assert.throws(() => restarted.changeMatchModel({ matchId: '9002', modelId: second, previousModel: first }, actor), /no longer connected/);
  restarted.changeMatchModel({ matchId: '9000', modelId: 'initial', previousModel: first }, actor);
  const active = controls.findLast(config => config.matchId === '9000');
  assert.equal(active.getModel().playerPolicies['2'], 'initial');
  assert.equal(active.getModel().experimental, undefined);
  assert.equal(restarted.status().settings.twoPlayerModel, second);
  assert.equal(controls.findLast(config => config.matchId === '9001').getModel().experimental.id, second);
  const another = create(settingsStore(directory));
  t.after(() => another.close());
  restarted.close();
  available = [game('9000')];
  await another.poll();
  assert.equal(controls.at(-1).getModel().playerPolicies['2'], 'initial');
  another.changeMatchModel({ matchId: '9000', modelId: second, previousModel: 'initial' }, actor);
  assert.equal(controls.at(-1).getModel().experimental.id, second);
});
