import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { challengeOptions, challengeStore } from './challenges.mjs';
import { declineInvitation, parseMyMatches } from './discovery.mjs';
import { createPlayerController } from './service.mjs';
import { settingsStore } from './settings.mjs';

const bot = 'NationsBot20', player = 'BetaPlayer';
const game = { id: '123', title: 'Test', players: [player, bot], playerCount: 2, invitation: true, section: 'Invitations:' };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nations-challenges-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

test('Discord and Tabony share a persistent active-game guard and UTC daily quota', t => {
  const directory = fixture(t);
  let now = Date.parse('2026-11-21T23:59:00Z');
  let store = challengeStore(directory, () => now);
  const { entry } = store.reserve(bot, player);
  store.submitting(entry);
  store = challengeStore(directory, () => now);
  assert.equal(store.reserve(bot, player, { matchId: game.id }).result, 'pending');
  const options = challengeOptions(bot, entry, count => count - 1);
  assert.equal(options.get('growth_resources'), '4');
  assert.equal(options.get('extra_draft_nations'), '2');
  assert.equal(options.has('weighted_card_draw'), false);
  assert.equal(options.has('korea_nerf'), true);
  const created = { ...game, invitation: false, section: 'Open:', title: options.get('title') };
  store.reconcile(bot, [created]);
  assert.deepEqual(store.check(player), { result: 'active', matchId: game.id });
  assert.equal(store.authorize(bot, created), true);
  store.reconcile(bot, [{ ...created, section: 'Completed:' }]);
  for (const id of ['124', '125', '126', '127']) {
    const reservation = store.reserve(bot, player, { matchId: id }).entry;
    assert.equal(store.reserve(bot, player, { matchId: id }).entry.key, reservation.key);
    assert.deepEqual(store.check(player), { result: 'active', matchId: id });
    store.confirm(reservation, id);
    store.finished(bot, id);
  }
  assert.equal(challengeStore(directory, () => now).reserve(bot, player).result, 'limit');
  assert.ok(store.reserve(bot, 'OtherPlayer').entry);
  now += 60000;
  assert.ok(store.reserve(bot, player).entry);
  assert.ok(challengeStore(directory, () => now).reserve(bot, player).entry);
});

test('one Discord user cannot reserve another challenge by changing Tabony usernames', t => {
  const directory = fixture(t);
  let now = Date.parse('2026-11-21T23:59:00Z');
  let store = challengeStore(directory, () => now);
  const initiator = { discordUserId: '229311536827465728' };
  const otherUser = { discordUserId: '821001820309815368' };
  const { entry } = store.reserve(bot, player, initiator);
  assert.equal(store.reserve(bot, 'AnotherPlayer', initiator).result, 'pending');
  assert.equal(store.reserve(bot, player, otherUser).result, 'pending');
  assert.ok(store.reserve(bot, 'IndependentPlayer', otherUser).entry);
  store.submitting(entry);
  store.confirm(entry, game.id);
  now += 60000;
  store = challengeStore(directory, () => now);
  assert.deepEqual(store.reserve(bot, 'AnotherPlayer', initiator), { result: 'active', matchId: game.id });
  store.finished(bot, game.id);
  assert.ok(store.reserve(bot, 'AnotherPlayer', initiator).entry);
});

test('direct invitations authorize a new player and explain active-game rejections', async t => {
  const directory = fixture(t), challenges = challengeStore(directory);
  const next = { ...game, id: '124' };
  let matches = [game], connected;
  const declined = [];
  const controller = createPlayerController({
    config: { username: bot, play: true, challenges },
    store: settingsStore(directory),
    discover: async () => [...matches],
    accept: async (_, controls) => {
      assert.equal(controls.beforeJoin({ accepted: [] }), false);
      assert.equal(controls.beforeJoin({ accepted: [player] }), true);
      return { lobbyStarted: true };
    },
    decline: async (match, { declineMessage, shouldDecline }) => {
      assert.ok(shouldDecline(match));
      declined.push(declineMessage); return true;
    },
    connect: async controls => { connected = controls.canPlay(); return true; },
  });
  t.after(() => controller.close());
  await controller.poll();
  assert.deepEqual(challenges.check(player), { result: 'active', matchId: game.id });
  matches = [next, { ...game, invitation: false, section: 'Your turn:' }];
  await controller.poll();
  assert.match(declined[0], /already have a NationsBot challenge/);
  assert.equal(connected, true);
  assert.deepEqual(challenges.check(player), {});
});

test('declining waits for the bot’s own chat echo, and retry uses persisted chat history', async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    sent = [];
    constructor() { super(); socket = this; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
  }
  const text = 'Finish your current NationsBot challenge first.';
  const controls = { username: bot, shouldDecline: () => true, declineMessage: text };
  const update = { players: game.players, accepted: [player], replaying: false };
  const emit = message => socket.emit('message', JSON.stringify(message));
  const echo = { player: bot, message: text };
  const done = declineInvitation(game, controls, 'test-session', FakeSocket);
  emit(update);
  emit({ chat: { ...echo, player } });
  emit(update);
  assert.deepEqual(socket.sent, [{ chat: text }]);
  emit({ chat: echo });
  assert.deepEqual(socket.sent, [{ chat: text }, { decline: bot }]);
  emit({ ...update, players: [player] });
  assert.equal(await done, true);

  const retried = declineInvitation(game, controls, 'test-session', FakeSocket);
  emit({ chat_log: [echo] });
  emit(update);
  assert.deepEqual(socket.sent, [{ decline: bot }]);
  emit({ ...update, players: [player] });
  assert.equal(await retried, true);
});

test('archived completion results can unlock a challenge after restart', () => {
  const html = `<span class="navbar-text py-0">Welcome, ${bot}!</span><h1>Your Archived Nations Matches</h1>
    <h2>Completed:</h2><div class="card my-2"><div>Players: <span>${bot}</span><span>${player}</span></div>
    <div>Type: <span>2-Player, King</span></div><a href="/nations/123/"></a></div>`;
  assert.equal(parseMyMatches(html, bot, { archived: true, includeCompleted: true })[0].section, 'Completed:');
});
