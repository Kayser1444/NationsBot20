import { parser } from '@lezer/python';
import { createHash } from 'node:crypto';

export const chunkVersion = 1;
export const textHash = text => createHash('sha256').update(text).digest('hex');
const words = text => text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]+|\d+/g) ?? [];
const terms = text => words(text).map(word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
const declarations = new Set(['FunctionDefinition', 'ClassDefinition']);

// Parse only, never import/execute the reference Python. Keep methods separate from their class.
function pythonRegions(text) {
  const root = { from: 0, to: text.length, context: [], children: [], symbol: null };
  function walk(node, parent) {
    if (declarations.has(node.name)) {
      const body = node.getChild('Body');
      const name = node.getChild('VariableName');
      const signature = text.slice(node.from, body?.from ?? node.to).trim().slice(0, 240);
      const symbol = [...(parent.symbol ? [parent.symbol] : []), name ? text.slice(name.from, name.to) : '?'].join('.');
      const current = { from: node.from, to: node.to, definitionFrom: node.from, symbol,
        context: [...parent.context, signature].slice(-3), children: [] };
      parent.children.push(current);
      for (let child = node.firstChild; child; child = child.nextSibling) walk(child, current);
    } else for (let child = node.firstChild; child; child = child.nextSibling) walk(child, parent);
  }
  walk(parser.parse(text).topNode, root);
  const regions = [];
  function emit(region) {
    let from = region.from;
    for (const child of region.children) {
      if (child.from > from) regions.push({ ...region, from, to: child.from });
      emit(child);
      from = child.to;
    }
    if (from < region.to) regions.push({ ...region, from, to: region.to });
  }
  emit(root);
  return regions;
}

export function createRetrievalChunks(documents, { countTokens } = {}) {
  const chunks = [];
  for (const document of documents) {
    if (['card-index', 'historical-context'].includes(document.kind)) continue;
    // License text is retained in the corpus but isn't an answer-retrieval candidate.
    if (document.kind === 'implementation' && !document.id.endsWith('.py')) continue;
    const { text, ...metadata } = document;
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const lineAt = offset => {
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) { const mid = (low + high) >> 1; if (lineStarts[mid] <= offset) low = mid; else high = mid; }
      return low + 1;
    };
    const regions = document.kind === 'implementation' ? pythonRegions(text) : [{ from: 0, to: text.length, context: [], symbol: null }];
    for (const region of regions) {
      for (let from = region.from; from < region.to;) {
        // Bound both characters and lines. Even a long one-line FAQ stays retrievable.
        const maximum = Math.min(region.to, from + 1000, lineStarts[lineAt(from) + 29] ?? text.length);
        let to = maximum;
        if (maximum < region.to) {
          const newline = text.lastIndexOf('\n', maximum - 1);
          if (newline > from + 250) to = newline + 1;
        }
        if (to <= from) to = Math.min(region.to, from + 1000);
        const context = region.context.join('\n').slice(-300);
        const identifiers = document.kind === 'implementation' ? [...new Set(words(context))].join(' ').slice(0, 120) : '';
        const prefix = `${document.kind}: ${document.title}\n${context}\n${identifiers}\n`;
        while (countTokens && countTokens(prefix + text.slice(from, to)) > 512 && to > from + 1) to = from + Math.floor((to - from) / 2);
        const excerpt = text.slice(from, to);
        if (excerpt.trim()) {
          const embeddingText = prefix + excerpt;
          chunks.push({ ...metadata, line: lineAt(from), endLine: lineAt(Math.max(from, to - 1)),
            ...(region.symbol ? { definitionLine: lineAt(region.definitionFrom), context } : {}),
            symbol: region.symbol, excerpt, embeddingText, hash: textHash(embeddingText) });
          if (chunks.length > 10000) throw new Error('Local retrieval corpus is too large.');
        }
        from = to;
      }
    }
  }
  return chunks;
}

export function normalizedVector(value, dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(n => !Number.isFinite(n))) throw new Error('Invalid embedding.');
  const norm = Math.sqrt(value.reduce((sum, n) => sum + n * n, 0));
  if (!Number.isFinite(norm) || norm < 1e-10) throw new Error('Invalid embedding norm.');
  return Float32Array.from(value, n => n / norm);
}

export function createChunkSearch(chunks, vectors) {
  if (chunks.length !== vectors.length) throw new Error('Incomplete vector index.');
  const tokens = chunks.map(chunk => terms(chunk.embeddingText));
  const counts = tokens.map(list => {
    const map = new Map(); for (const token of list) map.set(token, (map.get(token) ?? 0) + 1); return map;
  });
  const frequencies = new Map();
  for (const map of counts) for (const term of map.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const average = tokens.reduce((sum, list) => sum + list.length, 0) / Math.max(1, chunks.length);
  return ({ query, vector, scope = 'sources', cardType = 'all', mode = 'hybrid', limit = 14 }) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 240) return { error: 'Use a short English search query.' };
    const queryTerms = [...new Set(terms(query))];
    const candidates = chunks.map((chunk, index) => ({ chunk, index })).filter(({ chunk }) =>
      scope === 'cards' ? chunk.kind === 'card' && (cardType === 'all' || chunk.type === cardType) : chunk.kind !== 'card');
    const lexical = candidates.map(item => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = counts[item.index].get(term) ?? 0;
        const idf = Math.log(1 + (chunks.length - (frequencies.get(term) ?? 0) + 0.5) / ((frequencies.get(term) ?? 0) + 0.5));
        score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * tokens[item.index].length / average));
      }
      return { ...item, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    const semantic = mode === 'lexical' ? [] : candidates.map(item => ({ ...item,
      score: vectors[item.index].reduce((sum, n, i) => sum + n * vector[i], 0),
    })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 60);
    const fused = new Map();
    for (const ranking of mode === 'lexical' ? [lexical] : mode === 'semantic' ? [semantic] : [lexical, semantic]) {
      ranking.slice(0, 60).forEach((item, rank) => {
        const prior = fused.get(item.index);
        fused.set(item.index, { ...item, score: (prior?.score ?? 0) + 1 / (60 + rank + 1) });
      });
    }
    // One best passage per symbol (cards: per effect). Don't fill the response with one large class.
    const seen = new Set(), hits = [];
    for (const { chunk, score } of [...fused.values()].sort((a, b) => b.score - a.score || a.index - b.index)) {
      const key = chunk.kind === 'card' ? chunk.id : `${chunk.id}:${chunk.symbol ?? chunk.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { embeddingText, hash, ...hit } = chunk;
      hits.push({ ...hit, excerpt: chunk.excerpt.slice(0, 700), score: Math.round(score * 100000) / 100000, retrieval: mode });
      if (hits.length >= limit) break;
    }
    return hits;
  };
}
