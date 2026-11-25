import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import metadata from './package.json' with { type: 'json' };
import cards from './card-index.json' with { type: 'json' };
import rules from './predictor-rules.json' with { type: 'json' };
import { origin, login, readPosition, safeOption, StopPlayer } from './tabony.mjs';
import { chooseMove } from './policy.mjs';
import { validateModel } from './scorer.mjs';
import { chatLine, chatQuestion, createTabonyQuestionClient, publicMatchContext } from './chat-questions.mjs';
import { PublicRoundSession } from './public-round.mjs';

function safeArchitectOptions(state, username) {
  const options = state.next_move_options;
  const player = state.players[username];
  const project = player?.slots?.Hire;
  const stages = cards[project]?.stages;
  const completed = player?.cards?.[project]?.architects ?? 0;
  if (!stages?.length || completed + 1 !== stages.length) return options;

  const spaces = rules.nations[player.nation]?.wonders ?? 5;
  for (let i = 1; i <= spaces; i++) {
    const type = cards[player.slots[`W${i}`]]?.type;
    if (type !== 'natural-wonder' && type !== 'extension') return options;
  }

  // Tabony checks placement for normal hires, but some free hires bypass it.
  if (/^Hire (?:1 )?\[Architect\] for free\?$/.test(state.next_move_choice)) {
    return options.filter(move => move !== 'Yes');
  }
  if (state.next_move_choice === 'Which action?') {
    return options.filter(move => move !== 'Special of "Qin Dynasty"' && !/^Hire(?:$| from )/.test(move));
  }
  return options;
}

function configuration(env, managed) {
  const config = {
    matchId: env.TABONY_MATCH_ID,
    username: env.TABONY_USERNAME,
    opponent: env.TABONY_OPPONENT,
    password: env.TABONY_PASSWORD,
    dataDir: env.NATIONS_PLAYER_DATA_DIR ?? '/data',
    play: env.TABONY_PLAY === '1' && Boolean(env.TABONY_PASSWORD),
    encryptionKey: managed ? env.NATIONS_PLAYER_CREDENTIAL_ENCRYPTION_KEY : undefined,
  };
  if (managed && config.encryptionKey) return config;
  if (!/^\d{1,10}$/.test(config.matchId ?? '') ||
      ![config.username, config.opponent].every(name => /^[a-zA-Z0-9_]{1,20}$/.test(name ?? '')) ||
      config.opponent === config.username) {
    throw new StopPlayer('Set TABONY_MATCH_ID, TABONY_USERNAME, and TABONY_OPPONENT for one two-player test match.');
  }
  return config;
}

export async function journal(config) {
  const namespace = config.storageId ? `${config.storageId}-` : '';
  const path = join(config.dataDir, `match-${namespace}${config.matchId}.json`);
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
    let policyContext = {}, lastPolicy;
    let newest;
    const publicRound = new PublicRoundSession();
    const currentModel = () => config.getModel?.() ?? config.model;
    const policyId = (state, model) => model?.playerPolicies?.[Object.keys(state.players ?? {}).length === 2 ? '2' : '4'] ?? model?.name;
    function planMove(state, model) {
      const id = policyId(state, model);
      if (id !== lastPolicy) { policyContext = {}; lastPolicy = id; }
      const options = safeArchitectOptions(state, config.username);
      const guarded = options === state.next_move_options ? state : { ...state, next_move_options: options };
      const move = guarded !== state && options.length === 1 ? options[0]
        : chooseMove(guarded, config.username, config.opponent, model, policyContext);
      if (!safeOption(guarded, move)) throw new StopPlayer('No safe legal option was selected.');
      return move;
    }
    async function selectMove(state, model) {
      const direct = planMove(state, model);
      if (!model?.publicRound || Object.keys(state.players).length !== 2 || !config.roundRules) return direct;
      try {
        const result = await publicRound.decide(config.matchId, state, config.roundRules);
        const guarded = { ...state, next_move_options: safeArchitectOptions(state, config.username) };
        if (result.compared && result.trusted && safeOption(guarded, result.move)) return result.move;
      } catch (error) {
        console.log(`Match ${config.matchId}: public round search fell back to direct play (${error.message}).`);
      }
      return direct;
    }
    let lastValid = Date.now();
    let hasPosition = false;
    let lastLog;
    let finished = false;
    let fatal;
    const chatLife = new AbortController();
    const enabled = () => config.play && (!config.canPlay || config.canPlay());
    let answering = false, lastQuestionAt = -Infinity;

    function answerChat(chat) {
      if (!config.askQuestion || !session || !newest || newest.state.game_over ||
          !enabled() || answering || Date.now() - lastQuestionAt < 60_000) return;
      const { players } = newest;
      const question = chatQuestion(chat, players, config.username);
      if (!question) return;
      answering = true;
      lastQuestionAt = Date.now();
      const asker = chat.player;
      const snapshot = newest;
      void Promise.resolve().then(() => config.askQuestion({
        asker, question, matchContext: publicMatchContext(snapshot, players, config.username, asker), signal: chatLife.signal,
      })).then(reply => {
        const line = chatLine(reply);
        if (line && !chatLife.signal.aborted && !newest.state.game_over && enabled() && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ chat: line }));
        }
      }).catch(() => {
        if (!chatLife.signal.aborted) console.warn(`Match ${config.matchId}: Tabony chat question could not be answered.`);
      }).finally(() => { answering = false; });
    }

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
      chatLife.abort();
      clearInterval(timer);
      config.signal?.removeEventListener('abort', abort);
      chain.finally(() => fatal ? reject(fatal) : resolve(finished));
    });
    const abort = () => socket.terminate();
    config.signal?.addEventListener('abort', abort, { once: true });
    if (config.signal?.aborted) abort();
    socket.on('message', data => {
      if (fatal || socket.readyState !== WebSocket.OPEN) return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      let position;
      try { position = readPosition(message, config); }
      catch (error) {
        fatal = error;
        socket.terminate();
        return;
      }
      if (!position) {
        if (message?.chat) answerChat(message.chat);
        return;
      }
      newest = message;
      if (position.game_over) chatLife.abort();
      const stillCurrent = () => newest.state.move_number === position.move_number &&
        newest.state.next_move_player === position.next_move_player &&
        !newest.state.invalid_move && newest.log === message.log;
      chain = chain.then(async () => {
        if (fatal || socket.readyState !== WebSocket.OPEN) return;
        const state = { ...position, growth_allowances: message.growth_resources,
          weighted_card_draw: config.weightedCardDraw ?? position.weighted_card_draw };
        if (config.roundRules && typeof message.log === 'string') publicRound.observe({state, log: message.log});
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
          const turn = config.accountId ? (state.next_move_player === config.username ? 'this account' : 'another seat') : state.next_move_player;
          console.log(`Match ${config.matchId}: decision ${number}, waiting for ${turn}.`);
          lastLog = status;
        }
        config.onState?.(state, moves.pending);
        if (!enabled() || state.next_move_player !== config.username) return;
        if (moves.pending !== null) {
          if (state.invalid_move) throw new StopPlayer('Tabony reported an invalid move. Inspect the match before resuming.');
          return;
        }
        if (state.invalid_move) return;
        const delay = config.delay?.() ?? 0;
        if (delay) await sleep(delay, undefined, { signal: config.signal });
        if (!enabled() || !stillCurrent() || socket.readyState !== WebSocket.OPEN) return;
        const model = currentModel();
        let move = await selectMove(state, model);
        if (!stillCurrent() || socket.readyState !== WebSocket.OPEN) return;
        // Save first. A reconnect at the same position cannot send a duplicate.
        await moves.save(number);
        if (!enabled() || !stillCurrent() || socket.readyState !== WebSocket.OPEN) { await moves.save(null); return; }
        const latest = currentModel();
        if (policyId(state, latest) !== policyId(state, model) ||
            Boolean(latest?.publicRound) !== Boolean(model?.publicRound)) {
          try { move = planMove(state, latest); }
          catch (error) { await moves.save(null); throw error; }
        }
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
  const managed = Boolean(process.env.NATIONS_PLAYER_CONTROL_TOKEN);
  const config = configuration(process.env, managed);
  try { config.askQuestion = createTabonyQuestionClient(); }
  catch { console.warn('Invalid private Tabony question configuration. Chat replies are disabled.'); }
  if (managed) {
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
