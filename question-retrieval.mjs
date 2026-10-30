import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { defaultModelDirectory } from './question-embeddings.mjs';

const fingerprint = documents => createHash('sha256').update(JSON.stringify(documents)).digest('hex');

// CPU inference and parsing stay in a worker; existing literal search stays available throughout.
export function createLocalRetrieval({ directory, modelDirectory = defaultModelDirectory, report = () => {} }) {
  let worker, nextRequest = 0, active, currentKey, stats, failed = false, closed = false;
  const pending = new Map();
  function stop() {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Local retrieval stopped.')); }
    pending.clear();
    void worker?.terminate(); worker = null;
  }
  function request(message, timeout) {
    if (closed || failed) return Promise.reject(new Error('Local retrieval unavailable.'));
    if (!worker) {
      worker = new Worker(new URL('./question-vector-worker.mjs', import.meta.url), { workerData: { directory, modelDirectory } });
      worker.on('message', message => {
        if (message.progress) { report(`Local question embeddings: ${message.progress.completed}/${message.progress.total}.`); return; }
        const item = pending.get(message.request); if (!item) return;
        clearTimeout(item.timer); pending.delete(message.request);
        if (message.error) item.reject(new Error(message.error)); else item.resolve(message.value);
        if (!pending.size) worker?.unref();
      });
      const broken = () => { if (!closed) { failed = true; stop(); } };
      worker.on('error', broken);
      worker.on('exit', broken);
    }
    worker.ref();
    return new Promise((resolve, reject) => {
      const request = ++nextRequest;
      const timer = setTimeout(() => { failed = true; stop(); }, timeout);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ ...message, request });
    });
  }
  const prepare = async corpus => {
    if (closed || failed) return false;
    const documents = corpus.documents(), key = fingerprint(documents);
    if (key === currentKey) return true;
    if (active) { await active; return prepare(corpus); }
    active = (async () => {
      try {
        stats = await request({ operation: 'prepare', documents, key }, 900000);
        currentKey = key;
        report(`Local question index ready: ${stats.chunks} passages, ${stats.embedded} new embeddings, ${stats.reused} reused.`);
        if (!stats.cachePersisted) report('Local question index could not be cached; it will be rebuilt after restart.', 'error');
        return true;
      } catch {
        failed = true;
        stop();
        report('Local question index unavailable; literal retrieval remains active.', 'error');
        return false;
      } finally { active = null; }
    })();
    return active;
  };
  const search = ({ key = currentKey, query, scope = 'sources', cardType = 'all', mode = 'hybrid' }) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 240 || !['sources', 'cards'].includes(scope) ||
        !['hybrid', 'lexical', 'semantic'].includes(mode)) return Promise.resolve({ error: 'Use a short English search query.' });
    return request({ operation: 'search', key, query, scope, cardType, mode }, 3000);
  };
  return {
    prepare, search,
    status: () => ({ mode: closed ? 'closed' : failed ? 'fallback' : currentKey ? 'ready' : 'warming', ...stats }),
    forCorpus(corpus, onTelemetry = () => {}) {
      const key = fingerprint(corpus.documents());
      if (closed || failed || key !== currentKey) {
        void prepare(corpus);
        onTelemetry({ type: 'retrieval', phase: failed || closed ? 'fallback' : 'warming' });
        return corpus;
      }
      async function retrieve(args, scope) {
        const started = performance.now();
        const baseline = scope === 'cards' ? corpus.searchCards(args) : corpus.search(args);
        if (!Array.isArray(baseline)) return baseline;
        try {
          const cardType = args.card_type === 'all' && /\bevents?\b/i.test(args.query) ? 'event' : (args.card_type ?? 'all');
          const hits = await search({ key, query: args.query, scope, cardType });
          if (!Array.isArray(hits)) return baseline;
          // Reserve exact hits so semantic similarity cannot displace known names/symbols.
          const exact = baseline.slice(0, scope === 'cards' ? 3 : 4);
          const limit = scope === 'cards' ? 8 : 14;
          const combined = [...exact];
          for (const hit of [...hits, ...baseline]) {
            const duplicate = combined.some(item => item.id === hit.id && (scope === 'cards' ||
              Math.max(item.line, hit.line) <= Math.min(item.endLine ?? item.line, hit.endLine ?? hit.line)));
            if (!duplicate) combined.push(hit);
            if (combined.length >= limit) break;
          }
          onTelemetry({ type: 'retrieval', phase: 'hybrid', name: scope, durationMs: performance.now() - started, resultCount: Math.min(combined.length, limit) });
          return combined.slice(0, limit);
        } catch {
          onTelemetry({ type: 'retrieval', phase: 'fallback', name: scope, durationMs: performance.now() - started });
          return baseline;
        }
      }
      return { ...corpus, retrieval: 'hybrid', search: args => retrieve(args, 'sources'), searchCards: args => retrieve(args, 'cards') };
    },
    close() { closed = true; stop(); },
  };
}
