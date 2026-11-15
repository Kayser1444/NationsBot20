import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import metadata from './package.json' with { type: 'json' };
import { origin, login, readPosition, safeOption, StopPlayer } from './tabony.mjs';
import { chooseMove } from './policy.mjs';
import { validateModel } from './scorer.mjs';

function configuration(env) {
  const config = {
    matchId: env.TABONY_MATCH_ID,
    username: env.TABONY_USERNAME,
    opponent: env.TABONY_OPPONENT,
    password: env.TABONY_PASSWORD,
    dataDir: env.NATIONS_PLAYER_DATA_DIR ?? '/data',
    play: env.TABONY_PLAY === '1' && Boolean(env.TABONY_PASSWORD),
  };
  if (!/^\d{1,10}$/.test(config.matchId ?? '') ||
      ![config.username, config.opponent].every(name => /^[a-zA-Z0-9_]{1,20}$/.test(name ?? '')) ||
      config.opponent === config.username) {
    throw new StopPlayer('Set TABONY_MATCH_ID, TABONY_USERNAME, and TABONY_OPPONENT for one two-player test match.');
  }
  return config;
}

export async function journal(config) {
  const path = join(config.dataDir, `match-${config.matchId}.json`);
  let pending = null;
  if (!config.play) return { pending, async save() {} };
  try {
    if (!(await stat(config.dataDir)).isDirectory()) throw new Error();
    try {
      pending = JSON.parse(await readFile(path, 'utf8')).pending;
      if (pending !== null && (!Number.isSafeInteger(pending) || pending < 0)) throw new Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } catch {
    throw new StopPlayer('The player cannot read its persistent move journal.');
  }
  return {
    pending,
    async save(next) {
      await writeFile(`${path}.tmp`, JSON.stringify({ pending: next }), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      this.pending = next;
    },
  };
}

export function subscribe(config, session, moves, Socket = WebSocket) {
  return new Promise((resolve, reject) => {
    const url = `wss://games.tabony.net/ws/nations/${config.matchId}/`;
    const socket = new Socket(url, {
      origin,
      headers: session ? { Cookie: session } : {},
      handshakeTimeout: 12_000,
      maxPayload: 4 * 1024 * 1024,
    });
    let chain = Promise.resolve();
    let lastValid = Date.now();
    let hasPosition = false;
    let lastLog;
    let finished = false;
    let fatal;

    const timer = setInterval(() => {
      if (Date.now() - lastValid > 80_000) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) {
        // After the first snapshot, a null request only returns turn counts.
        // The site's "Live" replay command returns a full current position.
        socket.send(hasPosition ? JSON.stringify({ replay: { end: 0 } }) : 'null');
      }
    }, 30_000);
    socket.on('open', () => socket.send('null'));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearInterval(timer);
      config.signal?.removeEventListener('abort', abort);
      chain.finally(() => fatal ? reject(fatal) : resolve(finished));
    });
    const abort = () => socket.terminate();
    config.signal?.addEventListener('abort', abort, { once: true });
    if (config.signal?.aborted) abort();
    socket.on('message', data => {
      chain = chain.then(async () => {
        if (fatal || socket.readyState !== WebSocket.OPEN) return;
        let message;
        try { message = JSON.parse(data); } catch { return; }
        const state = readPosition(message, config);
        if (!state) return;
        hasPosition = true;
        lastValid = Date.now();
        const number = state.move_number;
        if (moves.pending !== null && number > moves.pending) {
          console.log(`Match ${config.matchId}: Tabony advanced past bot decision ${moves.pending} to ${number}.`);
          await moves.save(null);
        }
        if (state.game_over) {
          console.log(`Match ${config.matchId}: game over.`);
          finished = true;
          socket.close();
          return;
        }
        const status = `${number}:${state.next_move_player}`;
        if (status !== lastLog) {
          console.log(`Match ${config.matchId}: decision ${number}, waiting for ${state.next_move_player}.`);
          lastLog = status;
        }
        config.onState?.(state, moves.pending);
        const enabled = () => config.play && (!config.canPlay || config.canPlay());
        if (!enabled() || state.next_move_player !== config.username) return;
        if (moves.pending !== null) {
          if (state.invalid_move) throw new StopPlayer('Tabony reported an invalid move. Inspect the match before resuming.');
          return;
        }
        if (state.invalid_move) return;
        const delay = config.delay?.() ?? 0;
        if (delay) await sleep(delay, undefined, { signal: config.signal });
        if (!enabled() || socket.readyState !== WebSocket.OPEN) return;
        const move = chooseMove(state, config.username, config.opponent, config.getModel?.() ?? config.model);
        if (!safeOption(state, move)) throw new StopPlayer('No safe legal option was selected.');
        // Save first. A reconnect at the same position cannot send a duplicate.
        await moves.save(number);
        if (!enabled()) { await moves.save(null); return; }
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ move }));
        config.onMove?.(number, move);
        console.log(`Match ${config.matchId}: submitted bot decision ${number}: ${JSON.stringify(move)}.`);
      }).catch(error => {
        fatal = error;
        socket.terminate();
      });
    });
  });
}

async function run() {
  const config = configuration(process.env);
  if (process.env.NATIONS_PLAYER_CONTROL_TOKEN) {
    const { startPlayerService } = await import('./service.mjs');
    await startPlayerService({ config, subscribe, journal, login });
    return;
  }
  if (process.env.NATIONS_PLAYER_WEIGHTS) {
    const contents = await readFile(process.env.NATIONS_PLAYER_WEIGHTS, 'utf8');
    config.model = validateModel(JSON.parse(contents));
    console.log(`Nations scoring model: ${config.model.name}; SHA256 ${createHash('sha256').update(contents).digest('hex')}; profiles ${Object.keys(config.model.profiles ?? {}).join(', ')}.`);
  }
  const moves = await journal(config);
  if (moves.pending !== null) console.log(`Waiting to verify prior Tabony decision ${moves.pending} before making another move.`);
  const session = config.play ? await login(config) : null;
  console.log(`Nations headless player v${metadata.version} for match ${config.matchId}: ${config.play ? 'authenticated player' : 'observer'}.`);
  for (;;) {
    const finished = await subscribe(config, session, moves);
    if (finished) return;
    console.log('Tabony WebSocket disconnected. Reconnecting in 10 seconds.');
    await sleep(10_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    console.error(error instanceof StopPlayer ? error.message : 'The Nations player stopped after a connection or storage error.');
    process.exitCode = 1;
  });
}
