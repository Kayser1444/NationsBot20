import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { settingsStore, initialSettings, validateSettings, modelForSettings } from './settings.mjs';
import { parseMyMatches, isAuthorized, acceptInvitation, declineInvitation } from './discovery.mjs';
import { createPlayerController, startControlServer } from './service.mjs';
import deployed from './trained-weights.json' with { type: 'json' };

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nations-player-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return { directory, store: settingsStore(directory) };
}
const game = { id: '4000', title: 'Test', playerCount: 2, players: ['Kayser', 'NationsBot20'], invitation: true };
const config = { username: 'NationsBot20', play: true };

test('settings persist, reject stale writes and select the approved model profiles', t => {
  const { directory, store } = storeFixture(t);
  assert.deepEqual(modelForSettings(initialSettings).profiles['2'], deployed.profiles['2']);
  assert.deepEqual(modelForSettings(initialSettings).profiles['4'], deployed.profiles['4']);
  const next = { ...initialSettings, pollIntervalSeconds: 90, weightOverrides: { '2': { food: 9 }, '4': {} } };
  store.save(next, 0, '229311536827465728');
  assert.equal(settingsStore(directory).read().settings.pollIntervalSeconds, 90);
  assert.equal(modelForSettings(store.read().settings).profiles['2'].food, 9);
  assert.throws(() => store.save(initialSettings, 0), /Refresh/);
  for (const bad of [{ pollIntervalSeconds: 1 }, { pollingEnabled: 'false' }, { twoPlayerModel: 'constructor' }, { authorizedPlayers: ['<script>'] }, { weightOverrides: { 2: { constructor: 1 } } }]) {
    assert.throws(() => validateSettings({ ...initialSettings, ...bad }));
  }
});

test('account listing identifies invitations, ignores completed matches and verifies the account', () => {
  const card = `<div class="card my-2"><div>Title: <span>A &amp; B</span></div><div>Type: <span>2-Player, King</span></div><div>Players: <span>Kayser</span>, <span>NationsBot20 (invited)</span></div><a href="/nations/4000/"></a></div>`;
  const html = `<span class="navbar-text py-0 me-3">Welcome, NationsBot20!</span><h1>Your Nations Matches</h1><h2>Invitations:</h2>${card}<h2>Completed:</h2>${card}`;
  assert.deepEqual(parseMyMatches(html, config.username), [{ ...game, title: 'A & B', section: 'Invitations:',
    weightedCardDraw: false, roundRules: { weighted_card_draw: false, resource_remainder_tiebreaker: false,
      korea_nerf: false, lincoln_nerf: false } }]);
  assert.throws(() => parseMyMatches(html, 'AnotherBot'));
  assert.equal(isAuthorized(game, initialSettings, config.username), true);
  assert.equal(isAuthorized({ ...game, players: ['SomeoneElse', config.username] }, initialSettings, config.username), false);
  assert.equal(isAuthorized({ ...game, playerCount: 3, players: ['Kayser', 'SomeoneElse', config.username] }, initialSettings, config.username), true);
});

test('polling declines only ineligible pending invitations, independently of automatic acceptance', async t => {
  const { store } = storeFixture(t);
  const ineligible = { ...game, id: '4001', players: ['SomeoneElse', config.username] };
  const unconfirmed = { ...ineligible, id: '4004' };
  const invited = [ineligible, game, { ...ineligible, id: '4002', invitation: false },
    { ...game, id: '4003', playerCount: 6 }, unconfirmed];
  store.save({ ...initialSettings, autoAccept: false, playEnabled: false }, 0, '229311536827465728');
  const declined = [];
  const controller = createPlayerController({ config, store, discover: async () => invited,
    accept: () => assert.fail('Automatic acceptance is off.'),
    decline: async (match, controls) => {
      assert.equal(controls.shouldDecline(match), true);
      declined.push(match.id);
      if (match.id === unconfirmed.id) throw new Error('No response from Tabony.');
      return true;
    },
    connect: () => assert.fail('No eligible ongoing game.'),
  });
  t.after(() => controller.close());
  await controller.poll();
  assert.deepEqual(declined, []);
  controller.save({ ...store.read().settings, playEnabled: true }, 1, '229311536827465728');
  await controller.poll();
  assert.deepEqual(declined, [unconfirmed.id, ineligible.id]);
  assert.equal(controller.status().games.find(match => match.id === ineligible.id).status, 'invitation declined');
  assert.equal(controller.status().games.find(match => match.id === unconfirmed.id).status, 'decline unconfirmed');
});

test('manual polling works while disabled, coalesces requests and revocation closes a game', async t => {
  const { store } = storeFixture(t);
  store.save({ ...initialSettings, pollingEnabled: false }, 0, '229311536827465728');
  let discovered = 0, accepted = 0, resolveDiscovery, connected;
  const controller = createPlayerController({ config, store,
    discover: () => { discovered++; return new Promise(resolve => { resolveDiscovery = resolve; }); },
    accept: async () => { accepted++; },
    connect: async controls => { connected = controls; await new Promise(resolve => controls.signal.addEventListener('abort', resolve, { once: true })); return false; },
  });
  t.after(() => controller.close());
  await controller.tick(); assert.equal(discovered, 0);
  const first = controller.poll(), second = controller.poll();
  assert.equal(first, second); assert.equal(discovered, 1);
  resolveDiscovery([game, { ...game, id: '3999' }]); await first;
  assert.equal(accepted, 1); assert.equal(controller.status().games.filter(g => g.active).length, 1);
  assert.equal(connected.canPlay(), true);
  controller.save({ ...store.read().settings, playEnabled: false }, 1, '229311536827465728');
  assert.equal(connected.canPlay(), false);
  controller.save({ ...store.read().settings, authorizedPlayers: [] }, 2, '229311536827465728');
  assert.equal(connected.signal.aborted, true);
  assert.equal(controller.status().games.filter(g => g.active).length, 0);
});

test('finished games archive after 48 hours and keep their seat details across restarts', async t => {
  const { directory, store } = storeFixture(t);
  const match = { ...game, invitation: false };
  const finishedAt = Date.UTC(2026, 10, 21);
  let time = finishedAt;
  let connections = 0;
  const options = {
    config: { ...config, dataDir: directory, accountId: 'test-seat' }, store,
    discover: async () => [match], now: () => time,
    connect: async controls => {
      connections++;
      controls.onState({ move_number: 123, next_move_player: config.username }, 123);
      return true;
    },
  };
  const controller = createPlayerController(options);
  t.after(() => controller.close());
  await controller.poll();
  const [finished] = controller.status().games;
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishedAt, finishedAt);
  assert.equal(finished.active, false);
  assert.equal(finished.modelEditable, false);
  assert.equal(finished.decision, 123);
  assert.equal(finished.pending, null);
  await controller.close();

  time += 48 * 60 * 60 * 1000 - 1;
  const restarted = createPlayerController(options);
  t.after(() => restarted.close());
  assert.deepEqual(restarted.status().games, [finished]);
  time++;
  assert.deepEqual(restarted.status().games, [{ ...finished, status: 'archived' }]);
  assert.throws(() => restarted.changeMatchModel({ matchId: match.id }), { status: 409 });
  await restarted.poll();
  assert.equal(connections, 1);
});

test('invitation acceptance verifies participants, sends once and waits for confirmation', async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    sent = [];
    constructor() { super(); socket = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  }
  const controls = { ...config, settings: () => initialSettings };
  const done = acceptInvitation(game, controls, 'synthetic-session', FakeSocket);
  const update = { replaying: false, players: game.players, accepted: ['Kayser'] };
  socket.emit('message', JSON.stringify(update)); socket.emit('message', JSON.stringify(update));
  assert.deepEqual(socket.sent, [{ join: 2 }]);
  socket.emit('message', JSON.stringify({ ...update, accepted: game.players }));
  assert.deepEqual(await done, { lobbyStarted: true });
  const open = acceptInvitation({ ...game, playerCount: 4 }, controls, 'synthetic-session', FakeSocket);
  socket.emit('message', JSON.stringify(update));
  socket.emit('message', JSON.stringify({ ...update, accepted: game.players }));
  assert.deepEqual(await open, { lobbyStarted: false });
  const wrong = acceptInvitation(game, controls, 'synthetic-session', FakeSocket);
  socket.emit('message', JSON.stringify({ ...update, players: ['AnotherPlayer', config.username] }));
  await assert.rejects(wrong, /participants changed/); assert.deepEqual(socket.sent, []);
});

test('decline rechecks live eligibility and confirms that the bot seat was removed', async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    sent = [];
    constructor() { super(); socket = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  }
  const ineligible = { ...game, players: ['SomeoneElse', config.username] };
  const controls = { ...config, shouldDecline: match => !isAuthorized(match, initialSettings, config.username) };
  const update = { replaying: false, players: ineligible.players, accepted: ['SomeoneElse'], state: null };
  const emit = message => socket.emit('message', JSON.stringify(message));
  const done = declineInvitation(ineligible, controls, 'synthetic-session', FakeSocket);
  emit(update);
  emit(update);
  assert.deepEqual(socket.sent, [{ decline: config.username }]);
  emit({ ...update, players: ['SomeoneElse'] });
  assert.equal(await done, true);

  for (const live of [{ ...update, players: game.players }, { ...update, accepted: ineligible.players },
    { ...update, players: ['SomeoneElse'] }]) {
    const skipped = declineInvitation(ineligible, controls, 'synthetic-session', FakeSocket);
    emit(live);
    assert.equal(await skipped, false);
    assert.deepEqual(socket.sent, []);
  }
});

test('private control API requires its credential and checks settings revisions', async t => {
  const { store } = storeFixture(t);
  const controller = createPlayerController({ config, store, discover: async () => [], accept: async () => {}, connect: async () => true });
  const token = 'a'.repeat(64);
  const server = await startControlServer(controller, { token, port: 0, host: '127.0.0.1' });
  t.after(() => { controller.close(); server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/status')).status, 401);
  assert.equal((await fetch(url + '/match-model', { method: 'POST' })).status, 401);
  assert.equal((await fetch(url + '/challenge', { method: 'POST' })).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const discordUserId = '229311536827465728';
  const challenge = input => fetch(url + '/challenge', { headers, method: 'POST', body: JSON.stringify(input) });
  assert.equal((await challenge({ username: 'BetaPlayer' })).status, 400);
  assert.deepEqual(await (await challenge({ username: 'BetaPlayer', discordUserId })).json(), { result: 'unavailable' });
  assert.deepEqual(await (await challenge({ username: 'player/name', discordUserId })).json(), { result: 'unknown' });
  controller.challenge = async (username, userId) => {
    assert.equal(username, 'BetaPlayer');
    assert.equal(userId, discordUserId);
    return { result: 'created', matchId: '4000' };
  };
  assert.deepEqual(await (await challenge({ username: 'BetaPlayer', discordUserId })).json(), { result: 'created', matchId: '4000' });
  assert.equal((await fetch(url + '/status', { headers })).status, 200);
  const body = JSON.stringify({ settings: initialSettings, revision: 0, actor: '229311536827465728' });
  assert.equal((await fetch(url + '/settings', { headers, method: 'POST', body })).status, 200);
  assert.equal((await fetch(url + '/settings', { headers, method: 'POST', body })).status, 409);
  assert.equal((await fetch(url + '/poll', { headers, method: 'POST' })).status, 200);
  const matchModel = { matchId: '4000', modelId: 'initial', previousModel: 'human-baseline-v2' };
  assert.equal((await fetch(url + '/match-model', { headers, method: 'POST', body: JSON.stringify(matchModel) })).status, 400);
  assert.equal((await fetch(url + '/match-model', { headers, method: 'POST', body: JSON.stringify({ ...matchModel, actor: '229311536827465728' }) })).status, 409);
  await setImmediate();
});
