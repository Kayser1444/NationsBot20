import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractRulesDifferences, createRulesDifferencesStore, rulesDifferencesUrl } from '../question-errata.mjs';
import { createQuestionCorpus, dayMs } from '../question-sources.mjs';
import { createQuestionService } from '../question-service.mjs';
import { questionReplyParts, questionSourceFooter } from '../question-answer.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const seed = read('../data/question/tabony-rules-differences.json');
const code = read('../data/question/tabony-snapshot.json');
const fixture = entries => `<div id="p4"><a class="username">Logitude</a><div class="content"><strong>Known differences from the official rules:</strong><ul><li>Round effects vanish when replaced: <ul><li>Old Uppsala</li><li>Sheba</li></ul></li></ul><strong>Known differences from MaBiWeb's rules implementation:</strong><ul><li>${entries ?? 'Private architects are tied to the cards that provide them.'}</li></ul></div></div><div id="p5"><div class="content">Unrelated reply must not be indexed.</div></div>`;
const temporary = t => { const directory = mkdtempSync(join(tmpdir(), 'nations-errata-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; };

test('extracts only the owner post, preserves nested card names and separates official and MaBiWeb comparisons', () => {
  const data = extractRulesDifferences(fixture('A &amp; B &#039;architects&#039; &gt; 1'), seed.capturedAt);
  assert.equal(data.sections[0].entries.length, 1);
  assert.match(data.sections[0].entries[0], /Old Uppsala.*Sheba/);
  assert.match(data.sections[1].entries[0], /A & B 'architects' > 1/);
  assert.equal(JSON.stringify(data).includes('Unrelated reply'), false);
  assert.throws(() => extractRulesDifferences(fixture().replace('Logitude', 'Another user'), seed.capturedAt));
  assert.throws(() => extractRulesDifferences(fixture().replace('id="p4"', 'id="p40"'), seed.capturedAt));
  assert.throws(() => extractRulesDifferences('<html>Sign in required</html>', seed.capturedAt));
  assert.throws(() => extractRulesDifferences(fixture().replace('Known differences from the official rules:', 'Changed layout'), seed.capturedAt));
});

test('daily fixed-URL updater persists its schedule and retains last good notes on HTTP, parse and size failures', async t => {
  const directory = temporary(t); let clock = Date.parse('2026-10-16T00:00:00Z'), calls = 0, mode = 'ok';
  const options = { directory, now: () => clock, fetcher: async (url, request) => {
    calls++; assert.equal(url, rulesDifferencesUrl.split('#')[0]); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, undefined);
    return mode === 'http' ? new Response('', { status: 503 }) : new Response(mode === 'size' ? 'x'.repeat(250001) : mode === 'parse' ? '<html>login</html>' : fixture());
  } };
  let store = createRulesDifferencesStore(options); t.after(() => store.close());
  await store.update(); const good = store.snapshot(); assert.equal(calls, 1);
  await store.update(); assert.equal(calls, 1);
  store.close(); store = createRulesDifferencesStore(options); await store.update(); assert.equal(calls, 1);
  for (mode of ['http', 'parse', 'size']) {
    clock += dayMs; await store.update(); assert.deepEqual(store.snapshot(), good);
    await store.update();
  }
  assert.equal(calls, 4); assert.deepEqual(JSON.parse(readFileSync(join(directory, 'tabony-rules-differences.json'), 'utf8')), good);
  writeFileSync(join(directory, 'tabony-rules-differences.json'), '{damaged'); store.close();
  store = createRulesDifferencesStore(options); assert.deepEqual(store.snapshot(), seed);
});

test('Old Uppsala and private architects are searchable with distinct provenance and historical context', () => {
  const corpus = createQuestionCorpus(code, { entries: [] }, [], null, seed);
  const uppsala = corpus.search({ query: 'Old Uppsala' }).find(hit => hit.id.startsWith('tabony-rules-differences/'));
  assert.ok(uppsala);
  const source = corpus.read({ id: uppsala.id, count: 100 });
  assert.equal(source.author, 'Logitude'); assert.equal(source.url, rulesDifferencesUrl);
  assert.match(source.excerpt, /Officially.*effects should continue/);
  const architects = corpus.search({ query: 'Private architects' }).find(hit => hit.id.startsWith('tabony-rules-differences/'));
  const legacy = corpus.read({ id: architects.id });
  assert.match(legacy.comparison, /historical MaBiWeb/); assert.match(legacy.excerpt, /Unused private architects on replaced cards are lost/);
  assert.match(corpus.read({ id: 'context/mabiweb' }).excerpt, /no longer exists/);
});

test('service appends the fixed forum URL after notes are read, and captured code stamp remains the last line', async t => {
  let round = 0;
  const service = createQuestionService({ directory: temporary(t), env: { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only' },
    fetcher: async (url, request) => {
      if (url !== 'https://api.openai.com/v1/responses') return new Response('', { status: 503 });
      round++; const body = JSON.parse(request.body);
      assert.ok(body.instructions.includes('MaBiWeb')); assert.ok(body.instructions.includes('not official board-game errata'));
      if (round === 1) return Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'read_source', arguments: JSON.stringify({ id: 'tabony-rules-differences/official-2', start: 1, count: 100 }), call_id: 'notes' }] });
      const note = JSON.parse(body.input.find(item => item.type === 'function_call_output').output);
      assert.match(note.excerpt, /Old Uppsala/);
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ question_language: 'en', answer_language: 'en', english_question: null, parts: [{ text: 'Tabony removes the effect on replacement; the official rules retain it. tabony-rules-differences/official-2', english_text: null }] }) }] }] });
    } });
  t.after(() => service.close());
  const answer = await service.ask({ userId: '229311536827465728', question: 'Does Old Uppsala last after replacement?' });
  assert.ok(answer.includes(rulesDifferencesUrl)); assert.match(answer.split('\n').at(-1), /^AI interpretation · Tabony code captured:/);
  assert.equal(round, 2);
  const stamp = questionSourceFooter(code, 'en-US');
  const max = questionReplyParts(['a'.repeat(1800), 'b'.repeat(1800)], rulesDifferencesUrl + '\n' + stamp);
  assert.ok(max.every(part => part.length <= 2000));
  assert.match(questionSourceFooter(code, 'sv-SE'), /Tabony-kod hämtad:/);
});
