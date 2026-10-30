import test from 'node:test';
import assert from 'node:assert/strict';
import { investigateQuestion } from '../question-agent.mjs';

const call = (name, args, id) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
const response = output => new Response(JSON.stringify({ status: 'completed', output }));
const final = () => response([{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
  question_language: 'en', answer_language: 'en', english_question: null,
  parts: [{ text: 'See code/example.py:12 for the original evidence.', english_text: null }],
}) }] }]);

for (const mode of ['literal', 'hybrid']) test(`${mode} multi-round search keeps candidates and original reads within the context budget`, async () => {
  const hits = Array.from({ length: 14 }, (_, i) => ({ id: `code/source${i}.py`, kind: 'implementation', title: `source${i}.py`,
    line: 12, endLine: 35, definitionLine: 10, symbol: 'Example.method', context: 'class Example:\ndef method(self):',
    excerpt: 'candidate '.repeat(78), provenance: 'duplicated source metadata '.repeat(150), embeddingText: 'private index representation '.repeat(150) }));
  const originalRead = { id: 'code/example.py', commit: 'immutable-commit', excerpt: '12: original evidence '.repeat(450) };
  const corpus = { ...(mode === 'hybrid' ? { retrieval: mode } : {}), commit: 'test', fetchedAt: 'test',
    catalogue: () => [{ id: 'code/example.py' }], search: () => hits, searchCards: () => hits.slice(0, 8), read: () => originalRead };
  let requests = 0;
  const telemetry = [];
  const answer = await investigateQuestion({ corpus, question: 'Can this advisor be bought?', language: 'en-US', apiKey: 'test', reserveRequest() {},
    onTelemetry: event => telemetry.push(event),
    fetcher: async (_url, options) => {
      assert.ok(Buffer.byteLength(options.body) <= 90000);
      const body = JSON.parse(options.body);
      if (++requests === 1) return response([call('read_source', { id: originalRead.id, start: 12, count: 42 }, 'read'),
        call('search_cards', { query: 'advisor', card_type: 'all' }, 'cards')]);
      const outputs = body.input.filter(item => item.type === 'function_call_output');
      assert.deepEqual(JSON.parse(outputs.find(item => item.call_id === 'read').output), originalRead, 'read evidence and provenance stay intact');
      for (const item of outputs.filter(item => item.call_id !== 'read')) {
        const candidates = JSON.parse(item.output);
        const expected = item.call_id === 'cards' ? hits.slice(0, 8) : hits;
        assert.deepEqual(candidates.map(hit => hit.id), expected.map(hit => hit.id));
        assert.equal(candidates[0].definitionLine, 10); assert.equal(candidates[0].symbol, 'Example.method');
      }
      if (requests < 5) return response(Array.from({ length: 3 }, (_, i) => call('search_sources', { query: `advisor ${i}` }, `search-${requests}-${i}`)));
      return final();
    } });
  assert.equal(requests, 5); assert.match(answer, /original evidence/);
  assert.ok(telemetry.some(event => event.type === 'context' && event.phase === 'compact' && event.afterBytes < event.beforeBytes));
});

test('unavoidable context overflow has its own diagnostic before another paid request', async () => {
  let requests = 0;
  await assert.rejects(investigateQuestion({ question: 'Can this advisor be bought?', language: 'en-US', apiKey: 'test',
    corpus: { catalogue: () => [], read: () => ({ excerpt: 'source '.repeat(15000) }) }, reserveRequest() {},
    fetcher: async () => { requests++; return response([call('read_source', { id: 'code/example.py', start: 1, count: 100 }, 'read')]); },
  }), error => error.code === 'context_limit');
  assert.equal(requests, 1);
});
