import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { accountDatabase, accountStore } from './accounts.mjs';
import { createAccountManager } from './account-manager.mjs';
import { discoverAccountMatches } from './discovery.mjs';
import { createPlayerController } from './service.mjs';
import { initialSettings, settingsStore } from './settings.mjs';
import { journal } from './worker.mjs';

const key = 'f1'.repeat(32);
const actor = '229311536827465728';
const directoryFixture = t => {
  const directory = mkdtempSync(join(tmpdir(), 'nations-accounts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('vault encrypts both credentials, rejects a wrong key and imports a legacy account only once', t => {
  const directory = directoryFixture(t);
  const legacy = { username: 'NationsBot20', password: 'synthetic-password', play: true };
  let vault = accountStore(directory, key);
  vault.importLegacy(legacy);
  const [account] = vault.list();
  assert.equal(account.id, vault.legacyId());
  assert.equal(account.username, legacy.username);
  assert.equal(account.password, legacy.password);
  assert.equal(account.enabled, true);
  vault.close();
  const disk = readFileSync(join(directory, accountDatabase));
  assert.equal(disk.includes(legacy.username), false);
  assert.equal(disk.includes(legacy.password), false);
  assert.throws(() => accountStore(directory, 'e0'.repeat(32)), /encryption key/);
  vault = accountStore(directory, key);
  vault.delete(account.id);
  vault.importLegacy(legacy);
  assert.deepEqual(vault.list(), []);
  assert.equal(vault.idFor(legacy.username), account.id);
  vault.close();
});

test('three seats share a game with isolated defaults, model overrides, journals and start/stop', async t => {
  const directory = directoryFixture(t);
  const store = settingsStore(directory);
  store.save({ ...initialSettings, pollingEnabled: false }, 0, actor);
  const bots = ['NationsBot20', 'NationsBot20_2', 'NationsBot_3'];
  const match = { id: '4000', playerCount: 4, players: ['Kayser', ...bots], section: 'Not your turn:' };
  const experiments = new Map();
  experiments.scan = () => [];
  const control = new Map();
  const accepted = new Set();
  function createManager() {
    return createAccountManager({
      accounts: accountStore(directory, key),
      base: createPlayerController({ config: { dataDir: directory }, store, experiments }),
      experiments,
      createRuntime(config) {
        const controller = createPlayerController({
          config: { ...config, dataDir: directory }, store, experiments,
          discover: async () => [{ ...match, invitation: !accepted.has(config.username) }],
          accept: async () => accepted.add(config.username),
          connect(options) {
            control.set(config.username, options);
            return new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
          },
        });
        return { controller, close: () => controller.close() };
      },
    });
  }
  let manager = createManager();
  try {
    for (const username of bots) manager.changeAccount({ action: 'add', username, password: 'test-only', defaultModel: 'initial' });
    await manager.poll();
    const ids = manager.status().accounts.map(account => account.id);
    assert.equal(manager.status().games.length, 3);
    assert.equal(control.size, 0);
    assert.equal(JSON.stringify(manager.status()).includes('test-only'), false);
    manager.changeMatchModel({ accountId: ids[0], matchId: match.id, modelId: 'human-baseline-v2', previousModel: 'initial' }, actor);
    for (const accountId of ids) manager.changeAccount({ action: 'start', accountId });
    await manager.poll();
    assert.deepEqual([...accepted].sort(), [...bots].sort());
    assert.equal(control.size, 0);
    await manager.poll();
    assert.equal(control.size, 3);
    assert.equal(control.get(bots[0]).getModel().playerPolicies['4'], 'human-baseline-v2');
    assert.equal(control.get(bots[1]).getModel().playerPolicies['4'], 'initial');
    for (const [index, bot] of bots.entries()) await (await journal(control.get(bot))).save(index + 5);
    for (const [index, bot] of bots.entries()) assert.equal((await journal(control.get(bot))).pending, index + 5);
    manager.changeAccount({ action: 'stop', accountId: ids[0] });
    assert.equal(control.get(bots[0]).canPlay(), false);
    assert.equal(control.get(bots[0]).signal.aborted, true);
    assert.equal(control.get(bots[1]).canPlay(), true);
    manager.changeAccount({ action: 'default-model', accountId: ids[1], defaultModel: 'human-baseline-v2' });
    manager.changeAccount({ action: 'delete', accountId: ids[2] });
    assert.equal(control.get(bots[2]).signal.aborted, true);
    await manager.close();
    manager = createManager();
    await manager.poll();
    assert.deepEqual(manager.status().accounts.map(account => account.enabled), [false, true]);
    assert.deepEqual(manager.status().games.map(game => game.model), ['human-baseline-v2', 'initial']);
  } finally { await manager.close(); }
});

test('takeover discovery includes old games and accepts only approved ongoing seats', async t => {
  const username = 'RetiredPlayer';
  const players = [username, 'UnlistedOpponent'];
  const render = id => `<div class="card my-2"><div>Title: <span>League</span></div><div>Type: <span>2-Player, King</span></div><div>Players: ${players.map(name => `<span>${name}</span>`).join(', ')}</div><a href="/nations/${id}/"></a></div>`;
  const html = `<span class="navbar-text">Welcome, ${username}!</span><h1>Your Nations Matches</h1><h2>Your turn:</h2>${render('4000')}${render('4001')}<h2>Invitations:</h2>${render('4002')}<h2>Completed:</h2>${render('4003')}`;
  const discover = () => discoverAccountMatches('fixture', username, async url => {
    assert.equal(new URL(url).pathname, '/nations/archive/mine/');
    return new Response(html);
  }, true);
  const directory = directoryFixture(t);
  const store = settingsStore(directory);
  const connected = [];
  const experiments = { scan: () => [] };
  const manager = createAccountManager({
    accounts: accountStore(directory, key), experiments,
    base: createPlayerController({ config: {}, store, experiments }),
    createRuntime(config) {
      assert.equal(config.includeArchive, true);
      const controller = createPlayerController({ config, store, experiments, discover,
        accept: () => assert.fail('Takeover seats must already be in progress.'),
        connect: async options => { connected.push(options.matchId); return true; },
      });
      return { controller, close: () => controller.close() };
    },
  });
  try {
    manager.changeAccount({ action: 'add', username, password: 'fixture', matchIds: ['4000', '4002', '4003'] });
    manager.changeAccount({ action: 'start', accountId: manager.status().accounts[0].id });
    await manager.poll();
    assert.deepEqual(connected, ['4000']);
    assert.deepEqual(manager.status().games.map(game => game.id), ['4000']);
  } finally { await manager.close(); }
});

test('the last confirmed invitation connects every managed seat without another scheduled poll', async t => {
  const directory = directoryFixture(t);
  const store = settingsStore(directory);
  const bots = ['NationsBot20', 'NationsBot20_2', 'NationsBot_3'];
  const match = { id: '3278', playerCount: 4, players: ['Kayser', ...bots] };
  const accepted = new Set();
  const connected = new Set();
  const experiments = { scan: () => [] };
  const manager = createAccountManager({
    accounts: accountStore(directory, key), experiments,
    base: createPlayerController({ config: {}, store, experiments }),
    createRuntime(config) {
      const controller = createPlayerController({
        config: { ...config, dataDir: directory }, store, experiments,
        discover: async () => [{
          ...match, invitation: !accepted.has(config.username),
          section: accepted.size < bots.length ? 'Open:' :
            config.username === bots[0] ? 'Your turn:' : 'Not your turn:',
        }],
        accept: async () => {
          accepted.add(config.username);
          return { lobbyStarted: accepted.size === bots.length };
        },
        connect: async () => { connected.add(config.username); return true; },
      });
      return { controller, close: () => controller.close() };
    },
  });
  try {
    for (const username of bots) manager.changeAccount({ action: 'add', username, password: 'fixture' });
    for (const { id } of manager.status().accounts) manager.changeAccount({ action: 'start', accountId: id });
    await manager.poll();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...connected].sort(), [...bots].sort());
  } finally { await manager.close(); }
});
