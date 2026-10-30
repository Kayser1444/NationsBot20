// Retrieval benchmark only: no Discord, paid model, credentials, or network access.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalRetrieval } from '../question-retrieval.mjs';
import { loadEvaluationCorpus } from './question-evaluation-corpus.mjs';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const directory = option('directory') ?? '.data/question-retrieval-evaluation';
const cases = JSON.parse(readFileSync(new URL('../tests/fixtures/question-retrieval.json', import.meta.url), 'utf8'));
const corpus = loadEvaluationCorpus();
const retrieval = createLocalRetrieval({ directory, modelDirectory: option('model-directory'), report: message => console.error(message) });
const started = performance.now();
try {
  if (!await retrieval.prepare(corpus)) throw new Error('Prepare the local model with npm run question:model first.');
  const prepareMs = performance.now() - started;
  const telemetry = [];
  const hybridCorpus = retrieval.forCorpus(corpus, event => telemetry.push(event));
  const results = [];
  for (const item of cases) {
    const methods = {};
    for (const mode of ['literal', 'lexical', 'semantic', 'hybrid']) {
      const before = performance.now();
      const hits = mode === 'hybrid' ? await (item.scope === 'cards' ? hybridCorpus.searchCards({ query: item.query, card_type: item.cardType ?? 'all' }) : hybridCorpus.search({ query: item.query })) :
        mode === 'literal' ? (item.scope === 'cards' ? corpus.searchCards({ query: item.query, card_type: item.cardType ?? 'all' }) : corpus.search({ query: item.query })) :
        await retrieval.search({ query: item.query, scope: item.scope ?? 'sources', cardType: item.cardType ?? 'all', mode });
      if (!Array.isArray(hits)) throw new Error('Invalid benchmark search.');
      if (mode === 'hybrid' && telemetry.at(-1)?.phase !== 'hybrid') throw new Error('Hybrid retrieval fell back; benchmark comparison would be invalid.');
      const matches = (hit, expected) => hit.id === expected.id &&
        (!expected.symbol || hit.symbol === expected.symbol || (hit.id.startsWith('code/') && expected.line >= hit.line && expected.line <= (hit.endLine ?? hit.line)));
      const ranks = item.expected.map(expected => hits.findIndex(hit => matches(hit, expected)));
      const rank = item.allExpected ? (ranks.some(rank => rank < 0) ? -1 : Math.max(...ranks)) :
        hits.findIndex(hit => item.expected.some(expected => matches(hit, expected)));
      methods[mode] = { durationMs: Math.round((performance.now() - before) * 100) / 100, rank: rank < 0 ? null : rank + 1,
        hits: hits.slice(0, 5).map(({ id, line, symbol }) => ({ id, line, symbol })) };
    }
    results.push({ ...item, methods });
  }
  const summary = Object.fromEntries(['literal', 'lexical', 'semantic', 'hybrid'].map(mode => {
    const entries = results.map(result => result.methods[mode]);
    const times = entries.map(entry => entry.durationMs).sort((a, b) => a - b);
    return [mode, { foundAt5: entries.filter(entry => entry.rank && entry.rank <= 5).length,
      foundAt14: entries.filter(entry => entry.rank && entry.rank <= 14).length,
      mrr: Number((entries.reduce((sum, entry) => sum + (entry.rank ? 1 / entry.rank : 0), 0) / entries.length).toFixed(3)),
      medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] }];
  }));
  const report = { generatedAt: new Date().toISOString(), commit: corpus.commit, model: retrieval.status(), prepareMs: Math.round(prepareMs),
    note: 'Curated retrieval smoke cases, not a held-out evaluation or a measure of answer correctness. Code hits must reach the expected function or line.',
    cases: cases.length, summary, results };
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'evaluation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
} finally { retrieval.close(); }
