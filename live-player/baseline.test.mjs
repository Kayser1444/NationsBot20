import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import cases from './fixtures/baseline-regressions.json' with { type: 'json' };
import { chooseMove } from './policy.mjs';
import { predictAction } from './medium.mjs';
import { initialSettings, modelForSettings, settingsStore } from './settings.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const model = modelForSettings(initialSettings);
const stateAt = number => structuredClone(cases.find(row => row.decision === number).state);
const choose = (state, context) => chooseMove(state, state.next_move_player, null, model, context);

test('deployed baseline preserves Horse Archer and reproduces reviewed tactical choices', () => {
  for (const [decision, expected] of [[10, 'BM4'], [70, 'Buy P12'], [74, 'Undeploy from BM4'],
    [104, 'Buy P24'], [132, 'Buy P22']]) {
    assert.equal(choose(stateAt(decision)), expected, `decision ${decision}`);
  }
});

test('same-turn worker transfer completes and cannot leak into another position', () => {
  const state = stateAt(74), context = {};
  assert.equal(choose(state, context), 'Undeploy from BM4');
  const next = predictAction(state, state.next_move_player, 'Undeploy from BM4')[0].state;
  next.move_number++;
  next.next_move_options = ['Pass', 'Deploy to BM1'];
  assert.equal(choose(next, context), 'Deploy to BM1');
  assert.equal(context.transfer, null);
  const stale = { transfer: { decision: next.move_number - 1, move: 'Resign' } };
  assert.notEqual(choose(next, stale), 'Resign');
});

test('existing service upgrades once and preserves authorization, polling and later model selection', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nations-baseline-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'player-settings.json'), JSON.stringify({ revision: 9,
    settings: { ...initialSettings, twoPlayerModel: 'twenty-minute', multiplayerModel: 'full-hour',
      authorizedPlayers: ['Kayser', 'Friend'], pollIntervalSeconds: 120, playEnabled: false } }));
  const store = settingsStore(directory), saved = store.read();
  assert.equal(saved.revision, 10);
  assert.equal(saved.settings.twoPlayerModel, 'human-baseline-v2');
  assert.equal(saved.settings.multiplayerModel, 'human-baseline-v2');
  assert.deepEqual(saved.settings.authorizedPlayers, ['Kayser', 'Friend']);
  assert.equal(saved.settings.pollIntervalSeconds, 120);
  assert.equal(saved.settings.playEnabled, false);
  store.save({ ...saved.settings, twoPlayerModel: 'twenty-minute' }, 10, 'owner');
  assert.equal(settingsStore(directory).read().settings.twoPlayerModel, 'twenty-minute');
});
