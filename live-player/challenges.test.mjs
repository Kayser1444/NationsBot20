import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { challengeOptions, challengeStore } from './challenges.mjs';
import { notifyPendingInvitation, parseMyMatches } from './discovery.mjs';
import { createPlayerController } from './service.mjs';
import { initialSettings, settingsStore } from './settings.mjs';

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
  assert.equal(options.get('title'), 'BetaPlayer vs. NationsBot20 · 2026-11-21 23:59:00 UTC');
  assert.equal(options.get('title'), entry.title);
  assert.equal(options.get('growth_resources'), '4');
  assert.equal(options.get('extra_draft_nations'), '2');
  assert.equal(options.has('weighted_card_draw'), false);
  assert.equal(options.has('korea_nerf'), true);
  const created = { ...game, players: [bot, player], invitation: false, section: 'Open:', title: options.get('title') };
  store.reconcile(bot, [{ ...created, id: '122', players: [player, bot], invitation: true }, created]);
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

test('recovery still finds games created with the original UUID title', t => {
  const directory = fixture(t);
  const key = '073ef6c3-a5fe-48ef-be33-23d85db0ce9d';
  writeFileSync(join(directory, 'player-challenges.json'), JSON.stringify([{
    key, bot, username: player, status: 'creating', date: '2026-11-21', matchId: null,
  }]));
  const store = challengeStore(directory);
  store.reconcile(bot, [{ ...game, players: [bot, player], title: `NationsBot challenge - ${key}`, invitation: false, section: 'Open:' }]);
  assert.deepEqual(store.check(player), { result: 'active', matchId: game.id });
});

test('two matches for the same players get distinct titles even within the same second', t => {
  const store = challengeStore(fixture(t), () => Date.parse('2026-11-21T14:57:00Z'));
  const first = store.reserve(bot, player).entry;
  store.confirm(first, game.id);
  store.finished(bot, game.id);
  assert.equal(store.reserve(bot, player).entry.title, 'BetaPlayer vs. NationsBot20 · 2026-11-21 14:57:01 UTC');
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

test('direct invitations stay pending with a chat notice until the active challenge finishes', async t => {
  const directory = fixture(t), challenges = challengeStore(directory);
  const store = settingsStore(directory);
  store.save({ ...initialSettings, playMode: 'open' }, 0);
  const next = { ...game, id: '124' };
  let matches = [game], connected;
  const notices = [];
  const accepted = [];
  const controller = createPlayerController({
    config: { username: bot, play: true, challenges },
    store,
    discover: async () => [...matches],
    accept: async (match, controls) => {
      assert.equal(controls.beforeJoin({ accepted: [] }), false);
      assert.equal(controls.beforeJoin({ accepted: [player] }), true);
      accepted.push(match.id);
      return { lobbyStarted: true };
    },
    notifyInvitation: async (match, { message, shouldNotify }) => {
      assert.ok(shouldNotify(match));
      notices.push(message); return true;
    },
    connect: async controls => { connected = controls.canPlay(); return true; },
  });
  t.after(() => controller.close());
  await controller.poll();
  assert.deepEqual(challenges.check(player), { result: 'active', matchId: game.id });
  matches = [next];
  await controller.poll();
  await controller.poll();
  assert.deepEqual(accepted, [game.id]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /already have a NationsBot challenge/);
  assert.equal(controller.status().games.find(match => match.id === next.id).invitation, true);
  matches = [next, { ...game, invitation: false, section: 'Your turn:' }];
  await controller.poll();
  await controller.poll();
  assert.equal(connected, true);
  assert.deepEqual(accepted, [game.id, next.id]);
  assert.deepEqual(challenges.check(player), { result: 'active', matchId: next.id });
});

test('play modes control discovery and admission to direct challenges', async t => {
  const directory = fixture(t), challenges = challengeStore(directory);
  const store = settingsStore(directory);
  store.save({ ...initialSettings, playMode: 'closed' }, 0);
  let discoveryCalls = 0, joined = 0;
  const notices = [];
  const controller = createPlayerController({
    config: { username: bot, play: true, challenges }, store,
    discover: async () => { discoveryCalls++; return [game]; },
    notifyInvitation: async (_, controls) => { notices.push(controls.message); return true; },
    accept: async (_, controls) => {
      assert.equal(controls.beforeJoin({ accepted: [player] }), true);
      joined++;
      return { lobbyStarted: true };
    },
    connect: async () => assert.fail('The listing only contains invitations.'),
  });
  t.after(() => controller.close());
  await controller.poll();
  await controller.tick();
  await controller.notified();
  assert.equal(discoveryCalls, 0);
  controller.save({ ...initialSettings, playMode: 'invite-only' }, 1);
  await controller.poll();
  assert.equal(discoveryCalls, 1);
  assert.match(notices[0], /invite only/);
  assert.equal(joined, 0);
  controller.save({ ...initialSettings, playMode: 'open' }, 2);
  await controller.poll();
  assert.equal(discoveryCalls, 2);
  assert.equal(joined, 1);
});

test('a pending invitation notice waits for the bot’s own chat echo and uses persisted chat history', async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    sent = [];
    constructor() { super(); socket = this; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
  }
  const text = 'Finish your current NationsBot challenge first.';
  const controls = { username: bot, shouldNotify: () => true, message: text };
  const update = { players: game.players, accepted: [player], replaying: false };
  const emit = message => socket.emit('message', JSON.stringify(message));
  const echo = { player: bot, message: text };
  let confirmed = false;
  const done = notifyPendingInvitation(game, controls, 'test-session', FakeSocket).then(result => {
    confirmed = true;
    return result;
  });
  emit(update);
  assert.deepEqual(socket.sent, []);
  emit({ chat_log: [] });
  emit({ chat: { ...echo, player } });
  emit(update);
  assert.deepEqual(socket.sent, [{ chat: text }]);
  await Promise.resolve();
  assert.equal(confirmed, false);
  emit({ chat: echo });
  assert.equal(await done, true);
  assert.deepEqual(socket.sent, [{ chat: text }]);

  const retried = notifyPendingInvitation(game, controls, 'test-session', FakeSocket);
  emit({ chat_log: [echo] });
  emit(update);
  assert.equal(await retried, true);
  assert.deepEqual(socket.sent, []);
});

test('archived completion results can unlock a challenge after restart', () => {
  const html = `<span class="navbar-text py-0">Welcome, ${bot}!</span><h1>Your Archived Nations Matches</h1>
    <h2>Completed:</h2><div class="card my-2"><div>Players: <span>${bot}</span><span>${player}</span></div>
    <div>Type: <span>2-Player, King</span></div><a href="/nations/123/"></a></div>`;
  assert.equal(parseMyMatches(html, bot, { archived: true, includeCompleted: true })[0].section, 'Completed:');
});
