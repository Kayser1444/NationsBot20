// Offline verification of pinned observers, shared sockets and subscription removal.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, copyFileSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'sm-runtime-'));
for (const name of readdirSync(root)) if (name.endsWith('.mjs') || name === 'dashboard.html') copyFileSync(join(root, name), join(dir, name));
for (const name of ['cards', 'faq']) cpSync(join(root, 'data', name), join(dir, 'data', name), { recursive: true });
const match = { id: '1', title: 'S11-1A-P1', players: ['A', 'B', 'C', 'D'] };
writeFileSync(join(dir, 'sm-season.json'), JSON.stringify({ season: 11, divisions: { '1A': { players: match.players, matches: [match] } } }));
const config = { username: 'A', subscriptions: { A: '229311536827465728' }, discord: {}, matches: [match] };
writeFileSync(join(dir, 'friends.json'), JSON.stringify(config));
const sockets = [], nativeInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => nativeInterval(fn, ms === 5000 ? 50 : ms, ...args);
globalThis.WebSocket = class extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  constructor(url) { super(); this.url = url; sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send() { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ replaying: false, state: {
    game_over: 0, next_move_player: 'B', player_order: match.players,
    players: Object.fromEntries(match.players.map((name, i) => [name, { score: 10 - i, resource_remainder: 0 }])),
  } }) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
};
globalThis.fetch = async url => new Response(`<h1>${String(url).includes('/archive/') ? 'Archived Ongoing Nations Matches' : 'Ongoing Nations Matches'}</h1><li>None.</li>`);
delete process.env.NATIONS_DISCORD_BOT_TOKEN; delete process.env.NATIONS_DISCORD_WEBHOOK;
process.env.NATIONS_DATA_DIR = join(dir, 'data');
process.argv = [process.execPath, 'watch-kayser.mjs', '--config', 'friends.json', '--seconds', '1', '--no-dashboard', '--no-bot-commands'];
await import(pathToFileURL(join(dir, 'watch-kayser.mjs')));
await new Promise(resolve => setTimeout(resolve, 100));
assert.equal(sockets.length, 1, 'pinned and subscribed match share a socket');
writeFileSync(join(dir, 'friends.json'), JSON.stringify({ ...config, subscriptions: {} }));
await new Promise(resolve => setTimeout(resolve, 150));
assert.equal(sockets[0].readyState, 1, 'removing last subscriber must keep pinned observer');
const saved = JSON.parse(readFileSync(join(dir, 'data', 'sm-table-cache.json'), 'utf8'));
assert.equal(saved.snapshots['1'].state.players.A.score, 10);
await new Promise(resolve => setTimeout(resolve, 900));
assert.equal(sockets[0].readyState, 3);
rmSync(dir, { recursive: true, force: true });
console.log('PASS: one shared SM socket; subscription removal preserves SM monitoring; cache persists; shutdown closes socket.');
