import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export async function startTabonyQuestionServer({ ask, getPlayerLanguage, token, port, host = '::' }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '') || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid private Tabony question configuration.');
  }
  const credential = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    function send(status, data) {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) return send(401, {});
    if (req.method === 'GET' && req.url?.startsWith('/player-language?') && getPlayerLanguage) {
      const player = new URLSearchParams(req.url.slice('/player-language?'.length)).get('player');
      if (!/^[A-Za-z0-9_]{1,20}$/.test(player ?? '')) return send(400, {});
      try { return send(200, { language: getPlayerLanguage(player) }); }
      catch { return send(503, {}); }
    }
    if (req.method !== 'POST' || req.url !== '/question' || !ask) return send(404, {});
    if (req.headers['content-type'] !== 'application/json') return send(415, {});

    const cancellation = new AbortController();
    res.once('close', () => cancellation.abort());
    let input;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) return send(413, {});
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      if (!cancellation.signal.aborted) send(400, {});
      return;
    }
    const { asker, question, matchContext } = input ?? {};
    if (typeof asker !== 'string' || !/^[\p{L}\p{N}_@.+-]{1,150}$/u.test(asker) || typeof question !== 'string' ||
        question.length < 5 || question.length > 510 || matchContext?.asker !== asker ||
        typeof matchContext.bot !== 'string' || matchContext.bot === asker ||
        !Object.hasOwn(matchContext.players ?? {}, asker) || !Object.hasOwn(matchContext.players ?? {}, matchContext.bot)) return send(400, {});
    try {
      const reply = await ask({ asker, question, matchContext, signal: cancellation.signal });
      if (!cancellation.signal.aborted) send(200, { reply: reply ?? null });
    } catch {
      if (!cancellation.signal.aborted) send(503, {});
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
