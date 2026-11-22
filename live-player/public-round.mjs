import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { origin } from './tabony.mjs';

export const publicRoundId = 'public-round-100k';
export const direct100kId = 'rl-556d1e2a9f9d1fcf2422791c';
const runtime = fileURLToPath(new URL('./round-search/runtime.py', import.meta.url));
const maxDecisions = 120;

function entry(message) {
  if (typeof message.log !== 'string') throw new Error('Public history has no log');
  const state = message.state;
  // Only this round's log is needed for the action counter and temporary effects.
  const start = message.log.lastIndexOf('Beginning of Round ');
  return {state, log: message.log.slice(Math.max(0, start))};
}

export function readPublicHistory(matchId, start, latest, { Socket = WebSocket, timeoutMs = 6500 } = {}) {
  if (!/^\d{1,10}$/.test(matchId) || !Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(latest) || latest - start < 0 || latest - start > maxDecisions) {
    return Promise.reject(new Error('Public replays are outside the recovery window'));
  }
  if (start === latest) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const socket = new Socket(`wss://games.tabony.net/ws/nations/${matchId}/`, {
      origin, handshakeTimeout: timeoutMs, maxPayload: 4 * 1024 * 1024,
    });
    const history = [];
    let next = start;
    let settled = false;
    let started = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      if (error) reject(error); else resolve(history);
    }
    const timeout = setTimeout(() => finish(new Error('Public replay recovery timed out')), timeoutMs);
    socket.on('error', finish);
    socket.on('close', () => finish(new Error('Public replay connection closed')));
    const request = () => socket.send(JSON.stringify({replay: {to: next}}));
    socket.on('open', () => socket.send('null'));
    socket.on('message', bytes => {
      try {
        const reply = JSON.parse(bytes);
        if (!started && reply.replaying === false && reply.state) {
          if (reply.move_number !== latest) return finish(new Error('Match changed before public replay recovery'));
          started = true;
          request();
          return;
        }
        if (!reply.replaying) return;
        if (reply.move_number !== latest || reply.replay_position !== next || reply.state?.move_number !== next) {
          return finish(new Error('Match changed during public replay recovery'));
        }
        history.push(entry(reply));
        if (++next === latest) finish(); else request();
      } catch (error) { finish(error); }
    });
  });
}

export function runPublicRound(request, { python = process.env.NATIONS_PUBLIC_ROUND_PYTHON ?? 'python3',
                                         timeoutMs = 4500 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', runtime], {
      env: {...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1'},
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Round search timed out')); }, timeoutMs);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.stdin.on('error', () => {});
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 8192) child.kill();
    });
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error('Round search process failed');
        resolve(JSON.parse(output));
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

export class PublicRoundSession {
  history = [];
  previous = null;
  attempted = null;

  observe(message) {
    const current = entry(message);
    const previous = this.previous;
    if (previous?.state.round !== current.state.round) {
      this.history = [];
      this.attempted = null;
    } else if (current.state.move_number === previous.state.move_number + 1 &&
               current.log.startsWith(previous.log)) {
      this.history.push(previous);
    } else if (current.state.move_number !== previous.state.move_number || current.log !== previous.log) {
      this.history = [];
      this.attempted = null;
    }
    this.previous = current;
  }

  async decide(matchId, state, rules, { recover = readPublicHistory, score = runPublicRound } = {}) {
    const start = state.round_starts?.[state.round];
    if (!this.previous || this.previous.state.move_number !== state.move_number ||
        !Number.isSafeInteger(start) || state.phase !== 'Action Phase' || state.next_move_choice !== 'Which action?' ||
        state.next_move_options.length < 2 || !rules || !state.growth_allowances || state.move_number - start > maxDecisions) {
      return {move: null, compared: false, reason: 'ineligible'};
    }
    const first = this.history[0]?.state.move_number ?? this.previous.state.move_number;
    if (first !== start) {
      if (this.attempted === state.round) return {move: null, compared: false, reason: 'history unavailable'};
      this.attempted = state.round;
      const recovered = await recover(matchId, start, state.move_number);
      if (recovered.length !== state.move_number - start ||
          recovered.some((item, index) => item.state.round !== state.round ||
            item.state.move_number !== start + index ||
            !(recovered[index + 1] ?? this.previous).log.startsWith(item.log))) {
        return {move: null, compared: false, reason: 'inconsistent public history'};
      }
      this.history = recovered;
    }
    return score({history: this.history, root: this.previous, state: {
      ...state, resource_tiebreak: Boolean(rules.resource_remainder_tiebreaker),
      weighted_card_draw: Boolean(rules.weighted_card_draw),
    }, rules});
  }
}
