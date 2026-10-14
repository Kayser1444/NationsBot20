import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Events, GatewayIntentBits, MessageFlags, Routes } from 'discord.js';
import { createDiscordAuth } from '../admin-auth.mjs';
import { startDiscordBot } from '../discord-bot.mjs';
import { Outbox } from '../outbox.mjs';
import { observe } from '../turn-state.mjs';
import { liveSnapshot } from '../live-snapshot.mjs';

const owner = '229311536827465728', other = '821001820309815368';
const settings = { origin: 'https://admin.example.test', clientId: '1558936899446374570',
  clientSecret: 'synthetic-only', ownerId: owner };
function authFixture(t) {
  let time = 0, calls = 0;
  const auth = createDiscordAuth(settings, { now: () => time, fetcher: async url => {
    calls++;
    return url.endsWith('/oauth2/token')
      ? Response.json({ access_token: 'synthetic', token_type: 'Bearer', scope: 'identify' })
      : Response.json({ id: owner });
  } });
  t.after(() => auth.close());
  const call = async (path, address, cookie) => {
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} };
    await auth.handle({ method: 'GET', socket: { remoteAddress: address }, headers: { ...(cookie ? { cookie } : {}) } },
      response, new URL(path, settings.origin));
    return response;
  };
  const finish = (start, address) => call('/auth/callback?code=synthetic&state=' +
    new URL(start.headers.location).searchParams.get('state'), address, start.headers['set-cookie'].split(';')[0]);
  return { call, finish, advance: ms => { time += ms; }, calls: () => calls };
}

test('anonymous login flood is limited to its client and leaves another owner flow usable', async t => {
  const f = authFixture(t), victim = await f.call('/auth/login', '192.0.2.1');
  let limited = 0;
  for (let i = 0; i < 50; i++) if ((await f.call('/auth/login', '192.0.2.2')).status === 429) limited++;
  assert.ok(limited > 0, 'the abusive client must be throttled');
  assert.equal(f.calls(), 0, 'login starts must not call Discord');
  assert.equal((await f.call('/auth/login', '192.0.2.3')).status, 303, 'a second client can start before any pending flow finishes');
  assert.equal((await f.finish(victim, '192.0.2.1')).status, 303);
  assert.equal((await f.finish(victim, '192.0.2.1')).status, 400, 'callback replay stays rejected');
  f.advance(300001);
  assert.equal((await f.call('/auth/login', '192.0.2.2')).status, 303);
});

test('replacing a pending browser login invalidates the previous state without blocking the replacement', async t => {
  const f = authFixture(t);
  let latest = await f.call('/auth/login', '192.0.2.1'), original = latest;
  for (let i = 0; i < 4; i++) {
    latest = await f.call('/auth/login', '192.0.2.1', latest.headers['set-cookie'].split(';')[0]);
    assert.equal(latest.status, 303);
  }
  assert.equal((await f.finish(original, '192.0.2.1')).status, 400);
  assert.equal((await f.finish(latest, '192.0.2.1')).status, 303);
});

test('a full pending-login cache admits a fresh owner start instead of globally denying login', async t => {
  const f = authFixture(t);
  for (let i = 0; i < 1050; i++) await f.call('/auth/login', `client-${i}`);
  const start = await f.call('/auth/login', 'owner-client');
  assert.equal(start.status, 303);
  assert.equal((await f.finish(start, 'owner-client')).status, 303);
});

test('receipts survive unsubscribe and restart; a new follower and a later turn still get reminders', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nations-security-outbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'outbox.json'), destination = { guildId: 'guild', channelId: 'channel' };
  let box = new Outbox(path, destination);
  const match = { id: '1', title: 'Synthetic' }, turn = { player: 'Player', over: false }, sent = [];
  const flush = () => box.flush({ validate: async () => true, send: async job => sent.push(job.userId) });
  box.observe(match, turn, owner); await flush();
  for (let i = 0; i < 6; i++) {
    box.updateSubscriptions({ Player: owner }, {});
    box = new Outbox(path, destination);
    box.updateSubscriptions({}, { Player: owner });
    box.observe(match, turn, owner); await flush();
  }
  assert.deepEqual(sent, [owner], 'same turn must not be replayed by off/on or restart');
  box.updateSubscriptions({ Player: owner }, { Player: [owner, other] });
  box.observe(match, turn, [owner, other]); await flush();
  assert.deepEqual(sent, [owner, other], 'a new recipient still gets their first reminder');
  box.observe(match, { player: 'Other', over: false }, []);
  box.observe(match, turn, [owner, other]); await flush();
  assert.deepEqual(sent, [owner, other, owner, other]);
});

test('command flood is throttled per user, DM controls have a cooldown, and ordinary status remains available', async t => {
  let client, time = 0, dm = true, subscriptions = {}, checks = 0, commits = 0;
  const service = { getSubscriptions: () => subscriptions, getNames: () => ['Player'],
    commit: next => { commits++; subscriptions = next; }, getDm: () => dm, setDm: (_, value) => { dm = value; },
    getLocale: () => 'en-US', getStatus: () => ({ matches: 0, discordEnabled: true }),
    checkDm: async () => { checks++; } };
  class FakeClient extends EventEmitter {
    constructor() { super(); client = this; this.application = { id: settings.clientId };
      this.rest = { post: async () => ({}), get: async () => [], delete: async () => ({}) }; }
    async login() { this.emit(Events.ClientReady); }
    destroy() {}
  }
  const bot = startDiscordBot({ token: 'synthetic', guildId: 'guild', channelId: 'channel', service, now: () => time,
    loadLibrary: async () => ({ Client: FakeClient, Events, GatewayIntentBits, MessageFlags, Routes }) });
  t.after(() => bot.close()); await bot.ready;
  const run = async ({ id = owner, command = 'notifications', action = 'on', mode = null } = {}) => {
    const replies = [], interaction = { commandName: command, guildId: 'guild', channelId: 'channel', locale: 'en-US',
      user: { id, username: 'Player', bot: false }, isChatInputCommand: () => true, isAutocomplete: () => false,
      options: { getSubcommand: () => action, getString: name => name === 'nationsname' ? 'Player' : name === 'dm' ? mode : null },
      deferReply: async () => { interaction.deferred = true; }, editReply: async value => replies.push(value) };
    await client.listeners(Events.InteractionCreate)[0](interaction);
    return replies.at(-1).content;
  };
  for (let i = 0; i < 8; i++) await run();
  assert.equal(checks, 1, 'already subscribed users must not receive repeated control DMs');
  assert.match(await run({ action: 'off' }), /wait/i);
  assert.equal(commits, 1, 'throttled edits must not mutate subscriptions');
  assert.match(await run({ command: 'status' }), /Player/);
  await run({ id: other }); assert.equal(checks, 2, 'one user must not throttle another');
  time += 10001;
  await run({ mode: 'off' }); await run({ mode: 'on' });
  assert.equal(dm, true); assert.equal(checks, 2, 'rapid mode changes must not bypass DM cooldown');
  time += 60001;
  await run({ mode: 'off' }); await run({ mode: 'on' });
  assert.equal(checks, 3, 'later real DM enable may run another control');
});

test('malformed parsed game frames preserve previous state and later valid data still updates', () => {
  const previous = { player: 'Player', over: false, move: 1 };
  for (const message of [null, undefined, [], 0, true, 'bad', {}, { replaying: false, state: [] },
    { replaying: false, state: { game_over: 1, next_move_player: {} } }]) {
    assert.deepEqual(observe(previous, message, null), { state: previous, event: null });
  }
  assert.equal(observe(previous, { replaying: false, state: { game_over: 0, next_move_player: 'Other' } }, null).state.player, 'Other');
});

test('fresh snapshot check ignores malformed frames and resolves only from a valid game state', async t => {
  const original = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  globalThis.WebSocket = class extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send() {
      for (const data of ['null', '[]', '{broken', JSON.stringify({ replaying: false, state: { game_over: 0, next_move_player: 'Player' } })]) {
        this.dispatchEvent(new MessageEvent('message', { data }));
      }
    }
    close() {}
  };
  const state = await liveSnapshot('1', { timeoutMs: 100 });
  assert.equal(state.player, 'Player');
});
