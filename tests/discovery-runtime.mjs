// Offline integration check of the actual observer: no network or real Discord posts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const shared = process.env.NATIONS_TEST_SHARED === '1';
const secondUser = '821001820309815368';
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
    // Bad server frames must not crash the observer or its fresh snapshot check.
    for (const data of ['null', '[]', '"invalid"', '{broken']) this.dispatchEvent(new MessageEvent('message', { data }));
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
        const recipient = JSON.parse(options.body).recipient_id;
        assert.equal(recipient, shared ? secondUser : '229311536827465728');
        assert.ok(shared || dmEnabled);
        return Response.json({ id: dmChannel, type: 1, recipients: [{ id: recipient }] });
      }
      posts.push(JSON.parse(options.body));
      const isTurn = JSON.parse(options.body).content.includes('/nations/900000/');
      const channelId = isTurn && (dmEnabled || (shared && !JSON.parse(options.body).content.includes('<@'))) ? dmChannel : '1558878151646388264';
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
for (const name of ['cards', 'faq']) cpSync(join(root, 'data', name), join(dataDir, 'data', name), { recursive: true });
writeFileSync(join(dataDir, 'sm-season.json'), JSON.stringify({ season: 11, divisions: {} }));
const config = { subscriptions: { Kayser: '229311536827465728' }, matches: [],
  userLocales: { '229311536827465728': 'en-US' },
  languagePreferences: dmEnabled ? { '229311536827465728': 'sv-SE' } : {},
  discord: { guildId: '706912380067643473', channelId: '1558878151646388264' } };
config.dmPreferences = { '229311536827465728': dmEnabled };
if(shared){config.subscriptions.Kayser=['229311536827465728',secondUser];config.dmPreferences[secondUser]=true;config.userLocales[secondUser]='sv-SE';}
writeFileSync(join(configDir, 'friends.json'), JSON.stringify(config));
process.env.NATIONS_CONFIG_DIR = configDir;
process.env.NATIONS_DATA_DIR = configDir;
process.argv = [process.execPath, 'watch-kayser.mjs', '--config', 'friends.json', '--seconds', '2', '--no-dashboard', '--no-bot-commands'];
await import(pathToFileURL(join(dataDir, 'watch-kayser.mjs')));
await new Promise(resolve => realTimeout(resolve, 2300));
assert.ok(listingChecks >= 4, 'discovery must run repeatedly');
assert.equal(connections.filter(url => url.endsWith('/900000/')).length, shared ? 3 : 2, 'one observer plus one fresh check per recipient');
const turnPosts = posts.filter(post => post.content.includes('/nations/900000/'));
assert.equal(turnPosts.length, shared ? 2 : 1);
for (const post of turnPosts) {
  const privateReminder = dmEnabled || (shared && post === turnPosts[1]);
  if (privateReminder) {
    assert.ok(!post.content.includes('<@'));
    assert.deepEqual(post.allowed_mentions, { parse: [], users: [], roles: [] });
  } else {
    assert.match(post.content, /<@229311536827465728>/);
    assert.deepEqual(post.allowed_mentions, { parse: [], users: ['229311536827465728'] });
  }
}
if(shared){assert.ok(turnPosts[1].content.includes('Din tur i'));}
assert.match(turnPosts[0].content, /900000/);
assert.ok(turnPosts[0].content.includes(dmEnabled ? 'Din tur i' : 'Your turn in'), 'reminders follow persisted language preferences in either delivery mode');
const statusPosts = posts.filter(post => !post.content.includes('/nations/900000/'));
assert.equal(statusPosts.length, 2);
assert.equal(statusPosts[0].content, '🟢 Bevakningen har startat.');
assert.equal(statusPosts[1].content, '⚪ Bevakningen har stängts av.');
assert.deepEqual(statusPosts[0].allowed_mentions, { parse: [], users: [], roles: [] });
assert.equal(closedConnections.filter(url => url.endsWith('/900000/')).length, shared ? 3 : 2, 'all sockets close and discovery does not reopen completed games');
rmSync(dataDir, { recursive: true, force: true });
rmSync(configDir, { recursive: true, force: true });
console.log(`PASS: ${shared ? 'channel and DM' : dmEnabled ? 'DM-only' : 'channel'} reminders; only channel reminders mention users; completion disconnects; startup/shutdown each post once without mentions.`);
