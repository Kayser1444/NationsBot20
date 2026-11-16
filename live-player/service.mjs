import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { settingsStore, modelForSettings, modelChoices } from './settings.mjs';
import { discoverAccountMatches, isAuthorized, acceptInvitation } from './discovery.mjs';
import { origin, StopPlayer } from './tabony.mjs';
import metadata from './package.json' with { type: 'json' };
import baseline from './baseline-info.json' with { type: 'json' };
import { experimentalModels, isExperimentalModel } from './rl-policy.mjs';

function pinTwoPlayerModel(directory, matchId, selected) {
  if (!/^\d{1,10}$/.test(matchId)) throw new Error('Invalid match ID.');
  const path = join(directory, `player-model-${matchId}.json`);
  try {
    const { id } = JSON.parse(readFileSync(path, 'utf8'));
    if (!(isExperimentalModel(id) || id === 'human-baseline-v1' || modelChoices.some(model => model.id === id))) {
      throw new Error('Invalid saved checkpoint.');
    }
    return id;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writeFileSync(`${path}.tmp`, JSON.stringify({ id: selected }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return selected;
}

export function createPlayerController({ config, store, connect, discover, accept, now = Date.now,
  experiments = experimentalModels(config.dataDir), pin = pinTwoPlayerModel }) {
  const games = new Map(), events = [];
  let running = true, busy = null, lastPollAt = null, lastPollError = null, nextPollAt = null;
  let accountSocket = 'disconnected', modelRevision = -1, model;
  const settings = () => store.read().settings;
  const log = message => { events.unshift({ at: new Date(now()).toISOString(), message }); events.splice(50); console.log(message); };
  const getModel = () => {
    const saved = store.read();
    if (saved.revision !== modelRevision) { model = modelForSettings(saved.settings); modelRevision = saved.revision; }
    return model;
  };
  const gameModelId = game => {
    if (game.playerCount !== 2) return settings().multiplayerModel;
    const selected = settings().twoPlayerModel;
    if (isExperimentalModel(game.pinnedModel) || isExperimentalModel(selected)) return game.pinnedModel ?? selected;
    return selected;
  };
  function reconcile() {
    const s = settings();
    for (const game of games.values()) {
      if (game.abort && (!isAuthorized(game, s, config.username) || !s.playerCounts.includes(game.playerCount))) {
        game.abort.abort(); game.status = 'not authorized'; game.abort = null;
      }
    }
    nextPollAt = s.pollingEnabled ? (lastPollAt ?? now()) + s.pollIntervalSeconds * 1000 : null;
  }
  const activeCount = () => [...games.values()].filter(game => game.abort).length;
  function startGame(info) {
    const game = { ...info, status: 'connecting', abort: new AbortController(), decision: null, turn: null, pending: null, error: null };
    games.set(info.id, game);
    let experimental;
    try {
      if (info.playerCount === 2) {
        const selected = settings().twoPlayerModel;
        game.pinnedModel = config.dataDir ? pin(config.dataDir, info.id, selected) : selected;
        if (isExperimentalModel(game.pinnedModel)) {
          experimental = experiments.get(game.pinnedModel);
          if (!experimental) throw new Error('The pinned experimental checkpoint is unavailable.');
        }
      }
    } catch (error) {
      game.abort = null; game.status = 'blocked';
      game.error = isExperimentalModel(game.pinnedModel) ? 'The pinned experimental checkpoint is unavailable.' : 'The player could not read or save this match’s checkpoint.';
      log(`Match ${info.id}: ${game.error}`);
      return;
    }
    const getGameModel = () => {
      const id = gameModelId(game);
      if (game.playerCount !== 2 || id === settings().twoPlayerModel && !experimental) return getModel();
      return { ...modelForSettings({ ...settings(), twoPlayerModel: id }), experimental };
    };
    const controls = {
      ...config, matchId: info.id, players: info.players, signal: game.abort.signal,
      getModel: getGameModel, delay: () => settings().moveDelayMs,
      canPlay: () => running && settings().playEnabled && isAuthorized(game, settings(), config.username),
      onState(state, pending) { game.status = 'connected'; game.decision = state.move_number; game.turn = state.next_move_player; game.pending = pending; },
      onMove(number, move) { game.pending = number; game.lastMove = move; log(`Match ${info.id}: decision ${number}: ${move}`); },
    };
    const signal = game.abort.signal;
    void (async () => {
      while (running && !signal.aborted) {
        const finished = await connect(controls);
        if (finished) { game.status = 'completed'; log(`Match ${info.id}: completed.`); break; }
        if (!signal.aborted) { game.status = 'reconnecting'; await sleep(10000, undefined, { signal }); }
      }
    })().catch(error => {
      if (signal.aborted) return;
      game.status = 'blocked'; game.error = error instanceof StopPlayer ? error.message : 'Match connection stopped; inspect the game before retrying.';
      log(`Match ${info.id}: ${game.error}`);
    }).finally(() => { game.abort = null; });
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
        if (!isAuthorized(info, s, config.username)) { games.set(info.id, { ...info, status: 'not authorized' }); continue; }
        if (activeCount() >= s.maxConcurrentGames) { games.set(info.id, { ...info, status: 'waiting for capacity' }); continue; }
        if (info.invitation) {
          if (!s.autoAccept || !s.playEnabled || !config.play) { games.set(info.id, { ...info, status: 'invited' }); continue; }
          await accept(info, { ...config, settings });
          log(`Match ${info.id}: invitation accepted.`);
        }
        // A partly filled lobby remains discoverable until all names are known.
        if (info.players.length !== info.playerCount) { games.set(info.id, { ...info, invitation: false, status: 'waiting for players' }); continue; }
        if (isAuthorized(info, settings(), config.username)) startGame(info);
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
        polling: Boolean(busy), lastPollAt, lastPollError, nextPollAt, accountSocket,
        models: [...modelChoices, ...experiments.scan().map(({ id, label }) => ({ id, label, twoPlayerOnly: true }))],
        effectiveWeights: getModel().profiles,
        games: [...games.values()].map(({ abort, ...game }) => ({ ...game, active: Boolean(abort), model: gameModelId(game) })), events };
    },
    save(input, revision, actor) {
      if (isExperimentalModel(input?.twoPlayerModel) && input.twoPlayerModel !== settings().twoPlayerModel && !experiments.get(input.twoPlayerModel)) {
        throw new Error('That experimental checkpoint is unavailable.');
      }
      store.save(input, revision, actor); reconcile(); log('Player settings saved.'); return this.status();
    },
    poll(reason = 'manual') {
      if (!busy) { busy = performPoll(reason).finally(() => { busy = null; }); }
      return busy;
    },
    async tick() { if (running && settings().pollingEnabled && !busy && (nextPollAt === null || now() >= nextPollAt)) await this.poll('scheduled'); },
    async notified() { if (running && settings().pollingEnabled && (!lastPollAt || now() - lastPollAt >= 5000)) await this.poll('account notification'); },
    setAccountSocket(value) { accountSocket = value; },
    close() { running = false; for (const game of games.values()) game.abort?.abort(); },
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
      if (req.method === 'POST' && req.url === '/settings') {
        if (!req.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'JSON required.' }); return; }
        let body = '';
        for await (const chunk of req) { body += chunk.toString('utf8'); if (Buffer.byteLength(body) > 32768) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
        const input = JSON.parse(body);
        if (!/^\d{17,20}$/.test(input.actor ?? '')) throw new Error('An authenticated admin identity is required.');
        json(200, controller.save(input.settings, input.revision, input.actor)); return;
      }
      json(404, { error: 'Not found.' });
    } catch (error) { json(error.status ?? 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

export async function startPlayerService({ config, subscribe, journal, login }) {
  const store = settingsStore(config.dataDir);
  const experiments = experimentalModels(config.dataDir);
  experiments.scan();
  let session = await login(config);
  const controller = createPlayerController({ config, store, experiments,
    discover: async () => {
      try { return await discoverAccountMatches(session, config.username); }
      catch (error) {
        if (!(error instanceof StopPlayer)) throw error;
        session = await login(config);
        return discoverAccountMatches(session, config.username);
      }
    },
    accept: (match, controls) => acceptInvitation(match, controls, session),
    connect: async controls => subscribe(controls, session, await journal(controls)),
  });
  const port = Number(process.env.NATIONS_PLAYER_CONTROL_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid control port.');
  const server = await startControlServer(controller, { token: process.env.NATIONS_PLAYER_CONTROL_TOKEN, port });
  let stopped = false, socket, reconnect, keepAlive;
  const ignore = promise => promise.catch(() => {});
  function connectAccount() {
    if (stopped) return;
    socket = new WebSocket('wss://games.tabony.net/ws/nations/', { origin, headers: { Cookie: session }, handshakeTimeout: 12000 });
    socket.on('open', () => { controller.setAccountSocket('connected'); socket.send('null'); });
    socket.on('message', data => { try { if (Object.hasOwn(JSON.parse(data), 'turns')) ignore(controller.notified()); } catch {} });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => { clearInterval(keepAlive); controller.setAccountSocket('disconnected'); if (!stopped) reconnect = setTimeout(connectAccount, 10000); });
    keepAlive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 30000);
  }
  const timer = setInterval(() => ignore(controller.tick()), 1000);
  connectAccount();
  if (store.read().settings.pollingEnabled) ignore(controller.poll('startup'));
  console.log(`Nations player v${metadata.version}: control service ready; authenticated as ${config.username}.`);
  console.log(`Nations player model: ${store.read().settings.twoPlayerModel} (2p), ${store.read().settings.multiplayerModel} (3–5p).`);
  console.log(`Nations baseline SHA256 ${baseline.baseline_sha256}; human policy SHA256 ${baseline.human_policy_sha256}.`);
  const stop = () => { stopped = true; clearInterval(timer); clearInterval(keepAlive); clearTimeout(reconnect); socket?.terminate(); controller.close(); server.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return { controller, server, close: stop };
}
