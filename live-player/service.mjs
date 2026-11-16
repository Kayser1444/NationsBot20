import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { settingsStore, modelForSettings, modelChoices } from './settings.mjs';
import { discoverAccountMatches, isAuthorized, acceptInvitation } from './discovery.mjs';
import { origin, StopPlayer } from './tabony.mjs';
import metadata from './package.json' with { type: 'json' };
import baseline from './baseline-info.json' with { type: 'json' };
import { experimentalModels, isExperimentalModel } from './rl-policy.mjs';
import { accountDatabase, accountStore } from './accounts.mjs';
import { createAccountManager } from './account-manager.mjs';

function compatibleModel(id, playerCount) {
  return id === 'human-baseline-v1' || modelChoices.some(model => model.id === id)
    || (playerCount === 2 || playerCount === 4) && isExperimentalModel(id);
}

function matchModelPath(directory, matchId, storageId) {
  if (!/^\d{1,10}$/.test(matchId)) throw new Error('Invalid match ID.');
  return join(directory, `player-model-${storageId ? storageId + '-' : ''}${matchId}.json`);
}

function readMatchModel(directory, matchId, playerCount, storageId) {
  if (!directory) return null;
  try {
    const { id, manual = false } = JSON.parse(readFileSync(matchModelPath(directory, matchId, storageId), 'utf8'));
    if (!compatibleModel(id, playerCount) || typeof manual !== 'boolean') {
      throw new Error('Invalid saved checkpoint.');
    }
    return { id, manual };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeMatchModel(directory, matchId, selection, storageId) {
  if (!directory) return;
  const path = matchModelPath(directory, matchId, storageId);
  writeFileSync(`${path}.tmp`, JSON.stringify(selection), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function createPlayerController({ config, store, connect, discover, accept, now = Date.now,
  experiments = experimentalModels(config.dataDir) }) {
  const games = new Map(), events = [];
  const lifecycle = new AbortController(), connections = new Map();
  let running = true, busy = null, lastPollAt = null, lastPollError = null, nextPollAt = null;
  let accountSocket = 'disconnected', modelRevision = -1, model;
  const settings = () => store.read().settings;
  const accountEnabled = () => config.accountEnabled?.() ?? true;
  const authorized = game => config.authorize?.(game, settings()) ?? isAuthorized(game, settings(), config.username);
  const canPlay = game => running && accountEnabled() && settings().playEnabled && authorized(game);
  const log = message => { events.unshift({ at: new Date(now()).toISOString(), message }); events.splice(50); console.log(message); };
  const getModel = () => {
    const saved = store.read();
    if (saved.revision !== modelRevision) { model = modelForSettings(saved.settings); modelRevision = saved.revision; }
    return model;
  };
  const gameModelId = game => {
    if (game.modelPin?.manual) return game.modelPin.id;
    const accountDefault = config.defaultModel?.(game.playerCount);
    if (!game.modelPin && accountDefault) return accountDefault;
    if (game.playerCount !== 2) return settings().multiplayerModel;
    const selected = settings().twoPlayerModel;
    const pinned = game.modelPin?.id;
    if (isExperimentalModel(pinned) || isExperimentalModel(selected)) return pinned ?? selected;
    return selected;
  };
  function reconcile() {
    const s = settings();
    for (const game of games.values()) {
      if (game.abort && (!authorized(game) || !accountEnabled())) {
        game.abort.abort();
        game.status = authorized(game) ? 'stopped' : 'not authorized';
      }
    }
    nextPollAt = s.pollingEnabled ? (lastPollAt ?? now()) + s.pollIntervalSeconds * 1000 : null;
  }
  const activeCount = () => [...games.values()].filter(game => game.abort && !game.abort.signal.aborted).length;
  const readPin = game => readMatchModel(config.dataDir, game.id, game.playerCount, config.storageId);
  const writePin = (game, pin) => writeMatchModel(config.dataDir, game.id, pin, config.storageId);
  function loadPin(game) {
    try { game.modelPin = readPin(game); }
    catch { game.status = 'blocked'; game.error = 'The player could not read this seat’s checkpoint.'; }
    return game;
  }
  function startGame(info) {
    const game = loadPin({ ...info, status: 'connecting', abort: new AbortController(), decision: null, turn: null, pending: null, error: null });
    games.set(info.id, game);
    try {
      if (game.error) throw new Error(game.error);
      if (!game.modelPin && (config.accountId || info.playerCount === 2)) {
        game.modelPin = { id: gameModelId(game), manual: Boolean(config.accountId) };
        writePin(game, game.modelPin);
      }
      const id = gameModelId(game);
      if (isExperimentalModel(id)) {
        game.experimental = experiments.get(id);
        if (game.experimental?.playerCount !== game.playerCount) throw new Error('Missing compatible experimental checkpoint.');
      }
    } catch {
      game.abort = null; game.status = 'blocked';
      game.error = isExperimentalModel(game.modelPin?.id) ? 'The pinned experimental checkpoint is unavailable.' : 'The player could not read or save this match’s checkpoint.';
      log(`Match ${info.id}: ${game.error}`);
      return;
    }
    const getGameModel = () => {
      const id = gameModelId(game);
      const key = game.playerCount === 2 ? 'twoPlayerModel' : 'multiplayerModel';
      const current = settings();
      if (id === current[key] && !game.experimental) return getModel();
      return { ...modelForSettings({ ...current, [key]: id }), experimental: game.experimental };
    };
    const controls = {
      dataDir: config.dataDir, storageId: config.storageId, play: config.play, username: config.username, accountId: config.accountId,
      opponent: config.opponent, matchId: info.id, players: info.players, signal: game.abort.signal,
      getModel: getGameModel, delay: () => settings().moveDelayMs,
      canPlay: () => canPlay(game),
      onState(state, pending) { game.status = 'connected'; game.decision = state.move_number; game.turn = state.next_move_player; game.pending = pending; },
      onMove(number, move) { game.pending = number; game.lastMove = move; log(`Match ${info.id}: decision ${number}: ${move}`); },
    };
    const signal = game.abort.signal;
    const task = (async () => {
      while (running && !signal.aborted) {
        const finished = await connect(controls);
        if (finished && !signal.aborted) { game.status = 'completed'; log(`Match ${info.id}: completed.`); break; }
        if (!signal.aborted) { game.status = 'reconnecting'; await sleep(10000, undefined, { signal }); }
      }
    })().catch(error => {
      if (signal.aborted) return;
      game.status = 'blocked'; game.error = error instanceof StopPlayer ? error.message : 'Match connection stopped; inspect the game before retrying.';
      log(`Match ${info.id}: ${game.error}`);
    }).finally(() => { game.abort = null; connections.delete(task); });
    connections.set(task, signal);
    log(`Match ${info.id}: connecting (${info.playerCount} players).`);
  }
  async function performPoll(reason) {
    lastPollError = null;
    log(`Checking games: ${reason}.`);
    try {
      const found = await discover();
      if (!running) return;
      reconcile();
      for (const info of found.sort((a, b) => Number(b.id) - Number(a.id))) {
        const known = games.get(info.id);
        if (known?.status === 'completed' || known?.status === 'blocked' || known?.abort) continue;
        const s = settings();
        const show = status => games.set(info.id, loadPin({ ...info, status }));
        if (!authorized(info)) { if (!config.hideUnauthorized?.(info)) show('not authorized'); continue; }
        if (!running) break;
        if (!accountEnabled()) { show('stopped'); continue; }
        if (activeCount() >= s.maxConcurrentGames) { show('waiting for capacity'); continue; }
        if (info.invitation) {
          if (!s.autoAccept || !s.playEnabled || !config.play) { show('invited'); continue; }
          const joined = await accept(info, { username: config.username, settings, authorize: authorized, canPlay: () => canPlay(info), signal: lifecycle.signal });
          if (joined === false) continue;
          log(`Match ${info.id}: invitation accepted.`);
          if (config.accountId) {
            games.set(info.id, loadPin({ ...info, invitation: false, status: 'waiting for game to start' }));
            if (joined?.lobbyStarted) config.onLobbyStarted?.(info);
            continue;
          }
        }
        // A partly filled lobby remains discoverable until all names are known.
        if (info.players.length !== info.playerCount) {
          games.set(info.id, loadPin({ ...info, invitation: false, status: 'waiting for players' }));
          continue;
        }
        if (config.accountId && info.section === 'Open:') { show('waiting for game to start'); continue; }
        if (running && accountEnabled() && authorized(info)) startGame(info);
      }
      log(`Checked ${found.length} current game(s).`);
    } catch (error) {
      lastPollError = error instanceof StopPlayer ? error.message : 'Could not refresh games. The next poll will retry.';
      log(lastPollError);
      throw Object.assign(new Error(lastPollError), { status: 502 });
    } finally { lastPollAt = now(); reconcile(); }
  }
  return {
    status() {
      return { ...store.read(), username: config.username, version: metadata.version, playAvailable: config.play,
        polling: Boolean(busy), lastPollAt, lastPollError, nextPollAt, accountSocket, matchModelChanges: true,
        models: [...modelChoices, ...experiments.scan().map(({ id, label, playerCount }) => ({
          id, label, playerCount, twoPlayerOnly: playerCount === 2,
        }))],
        effectiveWeights: getModel().profiles,
        games: [...games.values()].map(game => {
          const { abort, modelPin, experimental, ...publicGame } = game;
          return { ...publicGame, active: Boolean(abort && !abort.signal.aborted), model: gameModelId(game),
            ...(config.accountId ? { accountId: config.accountId, accountName: config.username,
              modelEditable: authorized(game) && game.status !== 'completed' } : {}) };
        }), events };
    },
    save(input, revision, actor) {
      if (isExperimentalModel(input?.twoPlayerModel) && input.twoPlayerModel !== settings().twoPlayerModel &&
          experiments.get(input.twoPlayerModel)?.playerCount !== 2) {
        throw new Error('That experimental checkpoint is unavailable for two-player games.');
      }
      store.save(input, revision, actor); reconcile(); log('Player settings saved.'); return this.status();
    },
    changeMatchModel({ matchId, modelId, previousModel }, actor) {
      const game = typeof matchId === 'string' && /^\d{1,10}$/.test(matchId) && games.get(matchId);
      if (!running || !game || !(config.accountId ? game.status !== 'completed' : game.abort && !game.abort.signal.aborted) || !authorized(game)) {
        throw Object.assign(new Error('This match is no longer connected.'), { status: 409 });
      }
      if (gameModelId(game) !== previousModel) throw Object.assign(new Error('The match model changed. Refresh and try again.'), { status: 409 });
      if (!compatibleModel(modelId, game.playerCount)) throw new Error('Choose a checkpoint available for this player count.');
      const experimental = isExperimentalModel(modelId) ? experiments.get(modelId) : undefined;
      if (isExperimentalModel(modelId) && experimental?.playerCount !== game.playerCount) {
        throw new Error('That experimental checkpoint is unavailable for this player count.');
      }
      const selection = { id: modelId, manual: true, updatedAt: new Date(now()).toISOString(), updatedBy: actor };
      try { writePin(game, selection); }
      catch { throw new Error('The player could not save the match model.'); }
      game.modelPin = selection;
      game.experimental = experimental;
      if (game.status === 'blocked' && !game.abort && game.error?.includes('checkpoint')) {
        game.status = 'waiting to connect'; game.error = null;
      }
      log(`Match ${game.id}: model changed to ${experimental?.label ?? modelChoices.find(model => model.id === modelId)?.label ?? modelId}.`);
      return this.status();
    },
    poll(reason = 'manual') {
      if (!busy) { busy = performPoll(reason).finally(() => { busy = null; }); }
      return busy;
    },
    async tick() { if (running && settings().pollingEnabled && !busy && (nextPollAt === null || now() >= nextPollAt)) await this.poll('scheduled'); },
    async notified() { if (running && settings().pollingEnabled && (!lastPollAt || now() - lastPollAt >= 5000)) await this.poll('account notification'); },
    async lobbyStarted() {
      await Promise.allSettled([busy]);
      if (running && accountEnabled() && settings().pollingEnabled) await this.poll('lobby started');
    },
    async resume() {
      await Promise.allSettled([busy, ...[...connections].filter(([, signal]) => signal.aborted).map(([task]) => task)]);
      if (running && accountEnabled()) await this.poll('account started');
    },
    setAccountSocket(value) { accountSocket = value; },
    reconcile,
    close() {
      running = false;
      lifecycle.abort();
      for (const game of games.values()) game.abort?.abort();
      return Promise.allSettled([busy, ...connections.keys()]);
    },
  };
}

export async function startControlServer(controller, { token, port = 8080, host = '::' }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Set a 32-byte player control credential.');
  const server = createServer(async (req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { json(401, { error: 'Unauthorized.' }); return; }
    try {
      if (req.method === 'GET' && req.url === '/status') { json(200, controller.status()); return; }
      if (req.method === 'POST' && req.url === '/poll') { await controller.poll(); json(200, controller.status()); return; }
      if (req.method === 'POST' && ['/settings', '/match-model', '/account'].includes(req.url)) {
        if (!req.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'JSON required.' }); return; }
        let body = '';
        req.setEncoding('utf8');
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 32768) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
        const input = JSON.parse(body);
        if (!/^\d{17,20}$/.test(input?.actor ?? '')) throw new Error('An authenticated admin identity is required.');
        if (req.url === '/account' && !controller.changeAccount) throw new Error('The account vault is not configured.');
        const status = req.url === '/account' ? controller.changeAccount(input, input.actor) : req.url === '/match-model'
          ? controller.changeMatchModel(input, input.actor)
          : controller.save(input.settings, input.revision, input.actor);
        json(200, status); return;
      }
      json(404, { error: 'Not found.' });
    } catch (error) { json(error.status ?? 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

function createAccountRuntime({ config, store, experiments, subscribe, journal, login, invite = acceptInvitation }) {
  let session, stopped = false, socket, reconnect, keepAlive;
  const ignore = promise => void promise.catch(() => {});
  async function listMatches() {
    const current = discoverAccountMatches(session, config.username);
    if (!config.includeArchive) return current;
    const archived = discoverAccountMatches(session, config.username, fetch, true);
    const [recent, old] = await Promise.all([current, archived]);
    return [...new Map([...old, ...recent].map(match => [match.id, match])).values()];
  }
  const controller = createPlayerController({ config, store, experiments,
    discover: async () => {
      if (session) {
        try { return await listMatches(); }
        catch (error) { if (!(error instanceof StopPlayer)) throw error; }
      }
      if (stopped) return [];
      session = await login(config);
      const matches = await listMatches();
      resetAccountSocket();
      connectAccount();
      return matches;
    },
    accept: (match, controls) => invite(match, controls, session),
    connect: async controls => subscribe(controls, session, await journal(controls)),
  });
  function resetAccountSocket() {
    clearInterval(keepAlive);
    clearTimeout(reconnect);
    const previous = socket;
    socket = null;
    previous?.terminate();
    controller.setAccountSocket('disconnected');
  }
  function connectAccount() {
    if (stopped) return;
    const current = new WebSocket('wss://games.tabony.net/ws/nations/', { origin, headers: { Cookie: session }, handshakeTimeout: 12000 });
    socket = current;
    current.on('open', () => { if (socket === current) { controller.setAccountSocket('connected'); current.send('null'); } });
    current.on('message', data => { try { if (socket === current && Object.hasOwn(JSON.parse(data), 'turns')) ignore(controller.notified()); } catch {} });
    current.on('error', () => current.terminate());
    current.on('close', () => {
      if (socket !== current) return;
      resetAccountSocket();
      if (!stopped) reconnect = setTimeout(connectAccount, 10000);
    });
    keepAlive = setInterval(() => { if (current.readyState === WebSocket.OPEN) current.ping(); }, 30000);
  }
  return { controller, close() { stopped = true; resetAccountSocket(); return controller.close(); } };
}

export async function startPlayerService({ config, subscribe, journal, login }) {
  const port = Number(process.env.NATIONS_PLAYER_CONTROL_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid control port.');
  if (!config.encryptionKey && existsSync(join(config.dataDir, accountDatabase))) {
    throw new StopPlayer('The account vault needs NATIONS_PLAYER_CREDENTIAL_ENCRYPTION_KEY.');
  }
  const store = settingsStore(config.dataDir);
  const experiments = experimentalModels(config.dataDir);
  experiments.scan();
  let runtime;
  if (config.encryptionKey) {
    const accounts = accountStore(config.dataDir, config.encryptionKey);
    const joining = new Map();
    async function invite(match, controls, session) {
      // Let each join finish before another account joins the same Tabony lobby.
      const task = (joining.get(match.id) ?? Promise.resolve()).catch(() => {}).then(() => {
        if (!controls.canPlay() || !controls.settings().autoAccept) return false;
        return acceptInvitation(match, controls, session);
      });
      joining.set(match.id, task);
      try { return await task; }
      finally { if (joining.get(match.id) === task) joining.delete(match.id); }
    }
    try {
      accounts.importLegacy(config);
      const base = createPlayerController({ config: { dataDir: config.dataDir }, store, experiments });
      const controller = createAccountManager({ accounts, base, experiments,
        createRuntime: account => createAccountRuntime({
          config: { dataDir: config.dataDir, ...account }, store, experiments, subscribe, journal, login, invite,
        }),
      });
      runtime = { controller, close: () => controller.close() };
    } catch (error) { accounts.close(); throw error; }
  } else {
    runtime = createAccountRuntime({ config, store, experiments, subscribe, journal, login });
  }
  const { controller } = runtime;
  let server;
  try { server = await startControlServer(controller, { token: process.env.NATIONS_PLAYER_CONTROL_TOKEN, port }); }
  catch (error) { await runtime.close(); throw error; }
  const ignore = promise => void promise.catch(() => {});
  const timer = setInterval(() => ignore(controller.tick()), 1000);
  if (store.read().settings.pollingEnabled) ignore(controller.poll('startup'));
  console.log(`Nations player v${metadata.version}: control service ready.`);
  console.log(`Nations player model: ${store.read().settings.twoPlayerModel} (2p), ${store.read().settings.multiplayerModel} (3–5p).`);
  console.log(`Nations baseline SHA256 ${baseline.baseline_sha256}; human policy SHA256 ${baseline.human_policy_sha256}.`);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    clearInterval(timer);
    server.close();
    return runtime.close();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return { controller, server, close: stop };
}
