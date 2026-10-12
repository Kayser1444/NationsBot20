import { observe } from './turn-state.mjs';

// Fresh public snapshot before each delivery, including after restarts/outages.
export function liveSnapshot(matchId, { signal, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://games.tabony.net/ws/nations/${matchId}/`);
    let done = false;
    const finish = (error, state) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      socket.close(); error ? reject(error) : resolve(state);
    };
    const aborted = () => finish(new Error('Turn verification cancelled.'));
    const timer = setTimeout(() => finish(new Error('Game did not answer turn verification.')), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    socket.addEventListener('open', () => { if (!done) socket.send('null'); });
    socket.addEventListener('message', ({ data }) => {
      if (done) return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      const result = observe(null, message, null);
      if (result.state) finish(null, result.state);
    });
    socket.addEventListener('error', () => finish(new Error('Could not verify the current turn.')));
    socket.addEventListener('close', () => { if (!done) finish(new Error('Game connection closed during turn verification.')); });
  });
}
