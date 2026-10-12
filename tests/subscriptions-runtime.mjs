// Exercise the real monitor and dashboard in an isolated folder, with game traffic mocked.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nations-subscriptions-'));
for (const name of readdirSync(root)) if (name.endsWith('.mjs') || name === 'dashboard.html') copyFileSync(join(root, name), join(dir, name));
writeFileSync(join(dir, 'friends.json'), JSON.stringify({ subscriptions: {}, matches: [], discord: {} }));
const nativeFetch = globalThis.fetch, originalLog = console.log;
let origin, searches = 0;
const sockets = [];
console.log = (...values) => { const found = values.join(' ').match(/Statusfönster: (http:\/\/127\.0\.0\.1:\d+)/); if (found) origin = found[1]; };
globalThis.WebSocket = class extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  constructor(url) { super(); this.url = url; sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send() { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ replaying: false, move_number: 1, state: { game_over: 0, next_move_player: 'Tester' } }) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
};
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, options);
  assert.ok(String(url).startsWith('https://games.tabony.net/'), 'no Discord or other external calls');
  searches++;
  const archive = String(url).includes('/archive/');
  return new Response(`<h1>${archive ? 'Archived Ongoing Nations Matches' : 'Ongoing Nations Matches'}</h1>${archive ? '<li>None.</li>' : '<div class="card my-2"><div>Title: <span>Test match</span></div><div>Players: <span>Tester</span></div><a href="/nations/999001/"></a></div>'}`);
};
delete process.env.NATIONS_DISCORD_WEBHOOK;
delete process.env.NATIONS_DISCORD_BOT_TOKEN;
process.env.NATIONS_DATA_DIR = join(dir, 'data');
process.argv = [process.execPath, 'watch-kayser.mjs', '--config', 'friends.json', '--port', '0'];
try {
  await import(pathToFileURL(join(dir, 'watch-kayser.mjs')));
  const html = await (await fetch(origin)).text();
  const token = html.match(/const token='([a-f0-9]+)'/)[1];
  const initial = await (await fetch(origin + '/api/status')).json();
  assert.deepEqual(initial.playerNames, ['Tester'], 'names are collected even with no subscribers');
  assert.equal(initial.matches.length, 0, 'listing all players must not open unrelated match sockets');
  const headers = { origin, 'x-nations-token': token, 'content-type': 'application/json' };
  const added = await fetch(origin + '/api/subscriptions', { method: 'POST', headers, body: JSON.stringify({ username: 'Tester', userId: '229311536827465728' }) });
  assert.equal(added.status, 200);
  const state = await (await fetch(origin + '/api/status')).json();
  assert.equal(state.subscribers[0].username, 'Tester');
  assert.equal(state.matches.length, 1);
  assert.equal(state.matches[0].connected, true);
  assert.deepEqual(state.playerNames, ['Tester']);
  assert.ok(searches >= 2, 'adding triggers immediate discovery of both listings');
  assert.equal((await fetch(origin + '/api/subscriptions/Tester', { method: 'DELETE', headers })).status, 200);
  const removed = await (await fetch(origin + '/api/status')).json();
  assert.equal(removed.subscribers.length, 0); assert.equal(removed.matches.length, 0);
  assert.equal(sockets[0].readyState, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'friends.json'), 'utf8')).subscriptions, {});
  const add = userId => fetch(origin + '/api/subscriptions', { method: 'POST', headers, body: JSON.stringify({ username: 'Tester', userId }) });
  const userId = '229311536827465728';
  assert.equal((await add(userId)).status, 200);
  assert.equal((await fetch(origin + '/api/bans/' + userId, { method: 'POST', headers })).status, 200);
  const banned = await (await fetch(origin + '/api/status')).json();
  assert.equal(banned.subscribers.length, 0); assert.equal(banned.matches.length, 0);
  assert.equal(banned.bannedUsers[0].userId, userId);
  assert.equal(banned.bannedUsers[0].nationsName, 'Tester');
  assert.equal(sockets.at(-1).readyState, 3);
  assert.equal((await add(userId)).status, 400, 'admin cannot recreate a banned subscription');
  assert.equal((await add('821001820309815368')).status, 200, 'released name is available to its rightful owner');
  assert.equal((await fetch(origin + '/api/bans/' + userId, { method: 'DELETE', headers })).status, 200);
  const unbanned = await (await fetch(origin + '/api/status')).json();
  assert.equal(unbanned.bannedUsers.length, 0);
  assert.equal(unbanned.subscribers.length, 1);
  assert.equal(unbanned.subscribers[0].userId, '821001820309815368', 'unban never restores an old claim');
} finally {
  process.emit('SIGTERM'); console.log = originalLog;
  rmSync(dir, { recursive: true, force: true });
}
console.log('PASS: live subscription edits persist, discover matches immediately, and close unused sockets.');
