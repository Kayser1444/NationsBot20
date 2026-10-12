// Offline integration check of the actual observer: no network or real Discord posts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dmEnabled = process.env.NATIONS_TEST_DM === '1';
const dmChannel = '1559000000000000001';
const connections = [], posts = [], closedConnections = [];
let listingChecks = 0;
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 300000 ? 100 : ms, ...args);
globalThis.WebSocket = class extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  constructor(url) {
    super(); this.url = url; connections.push(url);
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send() {
    const player = this.url.endsWith('/900000/') ? 'Kayser' : 'Other';
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ replaying: false, move_number: 1, state: { game_over: 0, next_move_player: player } }) }));
    if (this.url.endsWith('/900000/') && connections.filter(url => url === this.url).length === 1) {
      realTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ replaying: false, move_number: 2, state: { game_over: 1, next_move_player: null } }) })), 1200);
    }
  }
  close() { closedConnections.push(this.url); this.readyState = 3; this.dispatchEvent(new Event('close')); }
};
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address.startsWith('https://discord.com/')) {
    assert.ok(!address.includes('/webhooks/'), 'friends profile must never use the old webhook');
    assert.equal(options.headers.authorization, 'Bot offline_test');
    if (options.method === 'POST') {
      if (address.endsWith('/users/@me/channels')) {
        assert.equal(dmEnabled, true);
        return Response.json({ id: dmChannel, type: 1, recipients: [{ id: '229311536827465728' }] });
      }
      posts.push(JSON.parse(options.body));
      const isTurn = JSON.parse(options.body).content.includes('<@');
      const channelId = dmEnabled && isTurn ? dmChannel : '1558878151646388264';
      assert.ok(address.endsWith(`/channels/${channelId}/messages`));
      return Response.json({ id: 'test-message', channel_id: channelId, mentions: [{ id: '229311536827465728' }] });
    }
    return Response.json({ guild_id: '706912380067643473', id: '1558878151646388264', type: 0 });
  }
  const archived = address.endsWith('/archive/ongoing/');
  listingChecks++;
  const heading = archived ? 'Archived Ongoing Nations Matches' : 'Ongoing Nations Matches';
  const card = '<div class="card my-2"><div>Title: <span>New game</span></div><div>Players: <span>Kayser</span></div><a href="/nations/900000/"></a></div>';
  return new Response(`<h1>${heading}</h1>${archived ? '<li>None.</li>' : card}`);
};
process.env.NATIONS_DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/offline_test';
process.env.NATIONS_DISCORD_BOT_TOKEN = 'offline_test';
const dataDir = mkdtempSync(join(tmpdir(), 'nations-runtime-'));
const configDir = mkdtempSync(join(tmpdir(), 'nations-persistent-config-'));
const root = fileURLToPath(new URL('../', import.meta.url));
for (const name of readdirSync(root)) if (name.endsWith('.mjs') || name === 'dashboard.html') copyFileSync(join(root, name), join(dataDir, name));
const config = { subscriptions: { Kayser: '229311536827465728' }, matches: [],
  discord: { guildId: '706912380067643473', channelId: '1558878151646388264' } };
config.dmPreferences = { '229311536827465728': dmEnabled };
writeFileSync(join(configDir, 'friends.json'), JSON.stringify(config));
process.env.NATIONS_CONFIG_DIR = configDir;
process.env.NATIONS_DATA_DIR = configDir;
process.argv = [process.execPath, 'watch-kayser.mjs', '--config', 'friends.json', '--seconds', '2', '--no-dashboard', '--no-bot-commands'];
await import(pathToFileURL(join(dataDir, 'watch-kayser.mjs')));
await new Promise(resolve => realTimeout(resolve, 2300));
assert.ok(listingChecks >= 4, 'discovery must run repeatedly');
assert.equal(connections.filter(url => url.endsWith('/900000/')).length, 2, 'one observer plus one fresh delivery check');
const turnPosts = posts.filter(post => post.content.includes('<@'));
assert.equal(turnPosts.length, 1);
assert.match(turnPosts[0].content, /<@229311536827465728>/);
assert.match(turnPosts[0].content, /900000/);
const statusPosts = posts.filter(post => !post.content.includes('<@'));
assert.equal(statusPosts.length, 2);
assert.equal(statusPosts[0].content, '🟢 Bevakningen har startat.');
assert.equal(statusPosts[1].content, '⚪ Bevakningen har stängts av.');
assert.deepEqual(statusPosts[0].allowed_mentions, { parse: [], users: [], roles: [] });
assert.equal(closedConnections.filter(url => url.endsWith('/900000/')).length, 2, 'both sockets close and discovery does not reopen completed games');
rmSync(dataDir, { recursive: true, force: true });
rmSync(configDir, { recursive: true, force: true });
console.log(`PASS: one ${dmEnabled ? 'DM-only' : 'channel'} turn mention; completion disconnects; startup/shutdown each post once without mentions.`);
