import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createQuestionEmbedder, embeddingDimensions, embeddingIdentity } from './question-embeddings.mjs';
import { createRetrievalChunks, createChunkSearch, normalizedVector, chunkVersion } from './question-code-index.mjs';

let embedder, current, queue = Promise.resolve();
const cachePath = join(workerData.directory, 'vectors.json');
const identity = `${embeddingIdentity}:chunks-${chunkVersion}`;

async function prepare(documents, key) {
  if (current?.key === key) return current.stats;
  embedder ??= await createQuestionEmbedder({ directory: workerData.modelDirectory });
  const chunks = createRetrievalChunks(documents, { countTokens: embedder.countTokens });
  let cached = {}, validCache = false;
  try {
    if ((await stat(cachePath)).size <= 80000000) {
      const value = JSON.parse(await readFile(cachePath, 'utf8'));
      if (value.identity === identity && value.vectors && typeof value.vectors === 'object') { cached = value.vectors; validCache = true; }
    }
  } catch { /* Missing/damaged caches are disposable; source snapshots are authoritative. */ }
  const vectors = new Map(); let reused = 0;
  for (const chunk of chunks) if (!vectors.has(chunk.hash) && cached[chunk.hash]) {
    try { vectors.set(chunk.hash, normalizedVector(cached[chunk.hash], embeddingDimensions)); reused++; } catch { /* Re-embed invalid entries. */ }
  }
  const missing = [...new Map(chunks.filter(chunk => !vectors.has(chunk.hash)).map(chunk => [chunk.hash, chunk])).values()]
    .map(chunk => ({ chunk, length: embedder.countTokens(chunk.embeddingText) }))
    .sort((a, b) => a.length - b.length).map(item => item.chunk); // Reduce batch padding and peak memory.
  parentPort.postMessage({ progress: { phase: 'embedding', completed: 0, total: missing.length } });
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8);
    const values = await embedder.embed(batch.map(chunk => chunk.embeddingText));
    if (values.length !== batch.length) throw new Error('Incomplete embedding batch.');
    batch.forEach((chunk, index) => vectors.set(chunk.hash, normalizedVector(values[index], embeddingDimensions)));
    if ((i + 8) % 256 === 0) parentPort.postMessage({ progress: { phase: 'embedding', completed: i + batch.length, total: missing.length } });
  }
  const stats = { chunks: chunks.length, reused, embedded: missing.length, model: embeddingIdentity,
    vectorBytes: chunks.length * embeddingDimensions * 4 };
  // Build a complete replacement and persist vectors keyed by content (not line numbers).
  const next = { key, stats, search: createChunkSearch(chunks, chunks.map(chunk => vectors.get(chunk.hash))) };
  try {
    if (!validCache || missing.length || Object.keys(cached).length !== vectors.size) {
      await mkdir(workerData.directory, { recursive: true });
      const payload = { identity, vectors: Object.fromEntries([...vectors].map(([hash, vector]) => [hash, [...vector]])) };
      await writeFile(cachePath + '.tmp', JSON.stringify(payload), { mode: 0o600 });
      await rename(cachePath + '.tmp', cachePath);
    }
    stats.cachePersisted = true;
  } catch { stats.cachePersisted = false; } // A disposable-cache failure must not discard a valid in-memory index.
  current = next;
  stats.processRssBytes = process.memoryUsage().rss;
  return stats;
}

parentPort.on('message', message => {
  queue = queue.then(async () => {
    try {
      let value;
      if (message.operation === 'prepare') value = await prepare(message.documents, message.key);
      else if (message.operation === 'search') {
        if (!current || current.key !== message.key) throw new Error('Index snapshot mismatch.');
        const vector = message.mode === 'lexical' ? null : normalizedVector((await embedder.embed([message.query], true))[0], embeddingDimensions);
        value = current.search({ ...message, vector });
      } else throw new Error('Unsupported local retrieval operation.');
      parentPort.postMessage({ request: message.request, value });
    } catch { parentPort.postMessage({ request: message.request, error: 'Local retrieval unavailable.' }); }
  });
});
