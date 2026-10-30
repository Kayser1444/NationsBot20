import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRetrievalChunks, createChunkSearch, normalizedVector } from '../question-code-index.mjs';
import { createLocalRetrieval } from '../question-retrieval.mjs';
import { createQuestionService } from '../question-service.mjs';
import { investigateQuestion } from '../question-agent.mjs';

const temporary = t => { const path = mkdtempSync(join(tmpdir(), 'nations-vector-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };

test('Python chunks follow syntax, retain class context and original locations, and never execute source', () => {
  const text = `"""def fake(): this is documentation"""\nraise RuntimeError('must never run')\nclass Army(Base):\n    @property\n    def apply(self):\n        def inner():\n            return 2\n        return inner()\n\nclass Colony(Base):\n    def apply(self):\n        return 4\n`;
  const chunks = createRetrievalChunks([{ id: 'code/example.py', kind: 'implementation', title: 'example.py', text, commit: 'test-commit' }]);
  assert.ok(chunks.some(chunk => chunk.symbol === 'Army.apply'));
  assert.ok(chunks.some(chunk => chunk.symbol === 'Army.apply.inner'));
  assert.ok(chunks.some(chunk => chunk.symbol === 'Colony.apply'));
  assert.ok(!chunks.some(chunk => chunk.symbol?.includes('fake')));
  const army = chunks.filter(chunk => chunk.symbol === 'Army.apply');
  assert.ok(army.every(chunk => chunk.embeddingText.includes('class Army(Base)')));
  assert.ok(army.every(chunk => !chunk.excerpt.includes('return 2')));
  for (const chunk of chunks) {
    assert.equal(chunk.commit, 'test-commit');
    assert.ok((text.split('\n').slice(chunk.line - 1, chunk.endLine).join('\n') + '\n').includes(chunk.excerpt));
    assert.ok(chunk.endLine - chunk.line < 31);
  }
});

test('long functions and one-line documents stay bounded without losing searchable source content', () => {
  const text = `def resolve():\n${Array.from({ length: 100 }, (_, i) => `    value_${i} = ${i}`).join('\n')}`;
  const sources = [{ id: 'code/x.py', kind: 'implementation', title: 'x', text },
    { id: 'faq/long', kind: 'faq', title: 'Long FAQ', review: 'pending', text: 'Resource rules '.repeat(300) }];
  const chunks = createRetrievalChunks(sources, { countTokens: text => text.length });
  assert.ok(chunks.every(chunk => chunk.embeddingText.length <= 512));
  assert.equal(chunks.filter(chunk => chunk.id === 'faq/long').map(chunk => chunk.excerpt).join(''), sources[1].text);
  assert.ok(chunks.some(chunk => chunk.excerpt.includes('value_99')));
  assert.ok(chunks.filter(chunk => chunk.id === 'faq/long').every(chunk => chunk.line === 1 && chunk.review === 'pending'));
});

test('hybrid ranking respects card scopes, exact symbols, source metadata and finite vectors', () => {
  const chunks = createRetrievalChunks([
    { id: 'code/pay.py', kind: 'implementation', title: 'pay.py', text: 'def pay_food():\n    return subtract(food)\n' },
    { id: 'faq/famine', kind: 'faq', title: 'Famine', review: 'pending', text: 'A nation must spend provisions during starvation.' },
    { id: 'cards/event', kind: 'card', type: 'event', evidenceKind: 'printed-card', text: 'Lose food in famine.', title: 'Event' },
    { id: 'cards/advisor', kind: 'card', type: 'advisor', evidenceKind: 'implementation-description', text: 'Lose food in famine.', title: 'Advisor' },
  ]);
  const search = createChunkSearch(chunks, chunks.map(chunk => normalizedVector(chunk.id === 'faq/famine' ? [1, 0] : [0, 1], 2)));
  const semantic = search({ query: 'out of rations', vector: [1, 0], mode: 'semantic' });
  assert.equal(semantic[0].id, 'faq/famine');
  assert.equal(semantic[0].review, 'pending');
  assert.ok(semantic.every(hit => hit.kind !== 'card'));
  assert.equal(search({ query: 'pay_food', mode: 'lexical' })[0].symbol, 'pay_food');
  const events = search({ query: 'food', vector: [0, 1], scope: 'cards', cardType: 'event' });
  assert.equal(events.length, 1); assert.equal(events[0].id, 'cards/event');
  for (const value of [[NaN, 1], [Infinity, 0], [0, 0], [1]]) assert.throws(() => normalizedVector(value, 2));
});

test('missing offline model fails back to original search without disabling questions', async t => {
  const directory = temporary(t);
  const retrieval = createLocalRetrieval({ directory, modelDirectory: join(directory, 'missing-model') });
  t.after(() => retrieval.close());
  const corpus = { documents: () => [{ id: 'faq/test', kind: 'faq', title: 'Test', text: 'Original evidence' }], search: () => ['original'] };
  assert.equal(retrieval.forCorpus(corpus), corpus);
  assert.equal(await retrieval.prepare(corpus), false);
  assert.equal(retrieval.status().mode, 'fallback');
  assert.equal(retrieval.forCorpus(corpus).search()[0], 'original');
});

test('agent awaits local search, reads original evidence and keeps its existing tool restrictions', async () => {
  let round = 0, reserve = 0;
  const corpus = { retrieval: 'hybrid', commit: 'test', fetchedAt: '2026-10-30T00:00:00Z', catalogue: () => [],
    search: async () => { await Promise.resolve(); return [{ id: 'faq/test', line: 1, excerpt: 'Evidence' }]; },
    read: () => ({ id: 'faq/test', review: 'pending', excerpt: '1: Original evidence' }) };
  const invoke = (name, args) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: String(round) });
  const text = await investigateQuestion({ corpus, question: 'How does this work?', language: 'en-US', apiKey: 'test-only',
    reserveRequest: () => reserve++, fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.tools.map(tool => tool.name), ['search_cards', 'search_sources', 'read_source']);
      let output;
      if (++round === 1) output = [invoke('search_sources', { query: 'question' })];
      else if (round === 2) {
        assert.equal(JSON.parse(body.input.at(-1).output)[0].id, 'faq/test');
        output = [invoke('read_source', { id: 'faq/test', start: 1, count: 5 })];
      } else output = [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ question_language: 'en', answer_language: 'en', english_question: null,
        parts: [{ text: 'According to faq/test:1, original evidence.', english_text: null }] }) }] }];
      return new Response(JSON.stringify({ status: 'completed', output }));
    } });
  assert.match(text, /original evidence/); assert.equal(reserve, 3);
});

test('vector experiment is opt-in and its worker closes with the question service', t => {
  let created = 0, warmed = 0, closed = 0;
  const retrievalFactory = () => { created++; return { prepare: async corpus => { warmed++; assert.ok(corpus.documents().length > 800); },
    status: () => ({ mode: 'warming' }), close: () => closed++ }; };
  const options = { directory: temporary(t), env: { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only' }, retrievalFactory,
    fetcher: async () => new Response('', { status: 503 }) };
  const original = createQuestionService(options);
  assert.deepEqual(original.retrievalStatus(), { mode: 'literal' }); original.close(); assert.equal(created, 0);
  const hybrid = createQuestionService({ ...options, env: { ...options.env, NATIONS_QUESTION_RETRIEVAL: 'hybrid' } });
  assert.equal(created, 1); assert.equal(warmed, 1);
  assert.equal(hybrid.retrievalStatus().mode, 'warming');
  hybrid.close(); assert.equal(closed, 1);
});

test('real offline model reuses cached vectors and refreshes evidence when sources change', { skip: !process.env.NATIONS_VECTOR_TEST_MODEL_DIR }, async t => {
  const directory = temporary(t);
  const make = text => ({ documents: () => [{ id: 'code/test.py', kind: 'implementation', title: 'test.py', text, commit: text }],
    search: () => [], searchCards: () => [] });
  let retrieval = createLocalRetrieval({ directory, modelDirectory: process.env.NATIONS_VECTOR_TEST_MODEL_DIR });
  t.after(() => retrieval.close());
  const first = make('def resolve_famine():\n    """Pay food during famine."""\n    return food - 2\n');
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  t.after(() => clearInterval(heartbeat));
  assert.equal(await retrieval.prepare(first), true);
  clearInterval(heartbeat); assert.ok(ticks > 0, 'model loading and embedding leave the main event loop responsive');
  assert.equal(retrieval.status().embedded, 1);
  const hit = (await retrieval.forCorpus(first).search({ query: 'starvation food loss' }))[0];
  assert.equal(hit.symbol, 'resolve_famine'); assert.match(hit.excerpt, /food - 2/);
  const exact = { id: 'code/test.py', line: 1, excerpt: 'literal source hit' };
  const withLiteral = { ...first, search: () => [exact] };
  const events = [];
  const wrapped = retrieval.forCorpus(withLiteral, event => events.push(event));
  assert.deepEqual((await wrapped.search({ query: 'famine' }))[0], exact, 'known literal matches keep priority');
  retrieval.close();
  assert.deepEqual(await wrapped.search({ query: 'famine' }), [exact], 'worker loss during a question falls back to the same corpus');
  assert.equal(events.at(-1).phase, 'fallback');
  retrieval = createLocalRetrieval({ directory, modelDirectory: process.env.NATIONS_VECTOR_TEST_MODEL_DIR });
  assert.equal(await retrieval.prepare(first), true);
  assert.equal(retrieval.status().embedded, 0); assert.equal(retrieval.status().reused, 1);
  const shifted = make('\n\n' + first.documents()[0].text);
  assert.equal(await retrieval.prepare(shifted), true);
  assert.equal(retrieval.status().embedded, 0, 'line shifts reuse identical enriched content');
  const shiftedHit = (await retrieval.forCorpus(shifted).search({ query: 'famine' }))[0];
  assert.equal(shiftedHit.line, 3); assert.equal(shiftedHit.definitionLine, 3);
  assert.equal(shiftedHit.commit, shifted.documents()[0].commit);
  const second = make('def resolve_famine():\n    return food - 5\n');
  assert.equal(retrieval.forCorpus(second), second, 'a stale index must never serve a new snapshot');
  assert.equal(await retrieval.prepare(second), true);
  assert.match((await retrieval.forCorpus(second).search({ query: 'famine' }))[0].excerpt, /food - 5/);
  assert.equal(retrieval.status().embedded, 1);
  const cache = JSON.parse(readFileSync(join(directory, 'vectors.json'), 'utf8'));
  assert.equal(Object.keys(cache.vectors).length, 1, 'obsolete embeddings are discarded');
  cache.vectors[Object.keys(cache.vectors)[0]] = [1];
  writeFileSync(join(directory, 'vectors.json'), JSON.stringify(cache));
  retrieval.close();
  retrieval = createLocalRetrieval({ directory, modelDirectory: process.env.NATIONS_VECTOR_TEST_MODEL_DIR });
  assert.equal(await retrieval.prepare(second), true);
  assert.equal(retrieval.status().embedded, 1, 'damaged cached vectors are rebuilt');
});
