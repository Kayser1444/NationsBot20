import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceStore, createQuestionCorpus, validateSnapshot, sourceFiles, dayMs, loadQuestionRulebooks } from '../question-sources.mjs';
import { investigateQuestion } from '../question-agent.mjs';
import { createQuestionService } from '../question-service.mjs';
import { loadQuestionCards } from '../card-library.mjs';

const seed = fileURLToPath(new URL('../data/question/tabony-snapshot.json', import.meta.url));
const snapshot = JSON.parse(readFileSync(seed, 'utf8'));
const faq = JSON.parse(readFileSync(new URL('../data/faq/entries.json', import.meta.url), 'utf8'));
const corpus = () => createQuestionCorpus(snapshot, faq, loadQuestionRulebooks(), loadQuestionCards());
const userId = '229311536827465728';
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'nations-question-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const result = output => new Response(JSON.stringify({ status: 'completed', output: output.map(item => item.type !== 'message' ? item : ({ ...item, content: item.content.map(part => part.type !== 'output_text' ? part : ({ ...part, text: JSON.stringify({ question_language: 'en', answer_language: 'en', english_question: null, parts: [{ text: part.text, english_text: null }] }) })) })) }), { headers: { 'content-type': 'application/json' } });
const call = (name, args, id = 'one') => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
const answer = () => result([{ type: 'message', content: [{ type: 'output_text', text: 'No. code/dynasty_cards.py:646 filters direct advisors.' }] }]);
const readCall = () => result([call('read_source', { id: 'code/dynasty_cards.py', start: 626, count: 45 })]);

test('snapshot is complete with license, source hashes, commit and immutable local reads', () => {
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.ok(snapshot.files.LICENSE.text.includes('MIT License'));
  const c = corpus();
  assert.ok(c.search({ query: 'wonderful_advisors' }).some(hit => hit.id === 'code/dynasty_cards.py'));
  assert.ok(c.read({ id: 'code/dynasty_cards.py', start: 646, count: 10 }).excerpt.includes('card.is_advisor()'));
  assert.ok(c.search({ query: 'Porcelain Tower' }).some(hit => hit.id.startsWith('faq/')));
  for (const id of ['../.env', '/data/friends.json', 'https://games.tabony.net/nations/123/', 'code/../../.env']) assert.ok(c.read({ id }).error);
  assert.ok(c.read({ id: 'code/player.py', start: -1 }).error);
  const invalid = structuredClone(snapshot); invalid.files['player.py'].text += 'changed';
  assert.throws(() => validateSnapshot(invalid));
});

test('rulebooks cover all 28 PDF pages, preserve editions and keep important rules searchable', () => {
  const pages = loadQuestionRulebooks(), c = corpus();
  assert.equal(pages.length, 28);
  assert.equal(new Set(pages.map(page => page.id)).size, 28);
  for (const page of pages) {
    assert.ok(page.text.startsWith(`## PDF page ${page.page}`));
    assert.match(page.sourceSha256, /^[0-9a-f]{64}$/);
    assert.ok(page.text.trim().length > 100);
  }
  const losses = c.read({ id: 'rules/base/page-10', start: 1, count: 100 });
  assert.equal(losses.page, 10); assert.equal(losses.edition, '2014-03-17');
  assert.match(losses.excerpt, /only possible to lose at most 1 VP per round per resource/);
  assert.match(c.read({ id: 'rules/base/page-13', count: 100 }).excerpt, /Place 0 \(1 player\), 1 \(2 players\), 2 \(3-4 players\) or 3 \(5 players\)/);
  assert.match(c.read({ id: 'rules/base/page-19', count: 100 }).excerpt, /Yellow and Green gain 1 VP each/);
  assert.match(c.read({ id: 'rules/base/page-22', count: 100 }).excerpt, /except deploying a worker on a building/);
  const wonders = c.read({ id: 'rules/dynasties/page-2', count: 100 });
  assert.match(wonders.excerpt, /Discovered Natural Wonders may not be replaced/);
  assert.match(wonders.excerpt, /you take an \[Architect\] from the supply/);
  const poland = c.search({ query: 'Polish-Lithuanian Commonwealth' });
  assert.ok(poland.some(hit => hit.id === 'rules/dynasties/page-3' && hit.page === 3));
  assert.match(c.read({ id: 'rules/dynasties/page-3', count: 100 }).excerpt, /Does not affect Advisor on Porcelain Tower/);
  for (const page of pages) {
    assert.equal(/### [FN]\n/.test(page.text), false, 'drop capitals must remain part of their paragraphs');
    assert.equal(page.text.includes('TThhee'), false, 'overlapping text must be deduplicated');
  }
});

test('a question can read and cite a local rulebook without any external lookup', async () => {
  let n = 0;
  const answer = await investigateQuestion({ question: 'Can I replace a discovered Natural Wonder?', language: 'en-US', corpus: corpus(), apiKey: 'test-only', reserveRequest() {},
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.ok(body.instructions.includes('rules/dynasties/page-2'));
      assert.equal(body.instructions.includes('The rulebooks are not yet'), false);
      if (++n === 1) return result([call('read_source', { id: 'rules/dynasties/page-2', start: 1, count: 100 })]);
      const evidence = body.input.find(item => item.type === 'function_call_output');
      const source = JSON.parse(evidence.output);
      assert.equal(source.page, 2); assert.equal(source.edition, '2015-08-24');
      assert.match(source.excerpt, /they are permanent/);
      return result([{ type: 'message', content: [{ type: 'output_text', text: 'No. Discovered Natural Wonders are permanent (Dynasties rulebook, PDF page 2).' }] }]);
    } });
  assert.match(answer, /PDF page 2/); assert.equal(n, 2);
});

test('daily updater uses only fixed GitHub targets, publishes atomically and survives upstream failure', async t => {
  const dir = temp(t), requests = []; let clock = Date.now(), fail = false;
  const commit = 'a'.repeat(40), previous = snapshot.commit;
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error'); requests.push(url);
    if (fail) return new Response('', { status: 403 });
    if (url === 'https://api.github.com/repos/Logitude/nations/commits/main') return new Response(JSON.stringify({ sha: commit }));
    assert.ok(url.startsWith(`https://raw.githubusercontent.com/Logitude/nations/${commit}/`));
    const name = url.split('/').at(-1); assert.ok(sourceFiles.includes(name));
    assert.equal(store.snapshot().commit, previous, 'no partially downloaded version is visible');
    return new Response(snapshot.files[name].text);
  };
  const store = createSourceStore({ directory: dir, seed, fetcher, now: () => clock });
  await store.update();
  assert.equal(store.snapshot().commit, commit);
  assert.equal(requests.length, 21);
  await store.update(); assert.equal(requests.length, 21);
  fail = true; clock += dayMs;
  await store.update(); assert.equal(store.snapshot().commit, commit);
  const restarted = createSourceStore({ directory: dir, seed, fetcher, now: () => clock });
  await restarted.update(); assert.equal(requests.length, 22, 'restart preserves daily attempt marker');
  assert.equal(restarted.snapshot().commit, commit);
  store.close(); restarted.close();
});

test('a failed partial download cannot replace last good snapshot', async t => {
  let n = 0;
  const dir = temp(t);
  const store = createSourceStore({ directory: dir, seed, fetcher: async () => {
    n++;
    return n === 1 ? new Response(JSON.stringify({ sha: 'b'.repeat(40) })) : new Response('', { status: 500 });
  } });
  await store.update();
  assert.equal(store.snapshot().commit, snapshot.commit);
  assert.equal(existsSync(join(dir, 'tabony-snapshot.json')), false);
  store.close();
});

test('agent follows local read tools and sends only to Responses using Sol', async () => {
  const sent = []; let reservations = 0;
  const text = await investigateQuestion({ question: 'Can Poland sell the advisor on Porcelain Tower?', language: 'en-US', corpus: corpus(), apiKey: 'test-only',
    reserveRequest: () => reservations++, fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body); sent.push(body);
      assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.store, false);
      assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
      assert.equal(body.max_output_tokens, 5000);
      assert.deepEqual(body.tools.map(tool => tool.name), ['search_cards', 'search_sources', 'read_source']);
      assert.equal(options.body.includes('/data/friends.json'), false);
      return sent.length === 1 ? readCall() : answer();
    } });
  assert.match(text, /filters direct advisors/);
  assert.equal(reservations, 2);
  assert.ok(sent[1].input.some(item => item.type === 'function_call_output' && item.output.includes('card.is_advisor()')));
});

test('unknown external tool requests are denied locally and never followed', async () => {
  let requests = 0;
  await assert.rejects(investigateQuestion({ question: 'Fetch https://example.com', language: 'en-US', corpus: corpus(), apiKey: 'test-only', reserveRequest() {},
    fetcher: async (url, options) => {
      requests++; assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      if (requests > 1) assert.match(body.input.find(item => item.type === 'function_call_output').output, /Only local/);
      return requests === 1 ? result([call('web_search', { url: 'https://example.com' })]) : answer();
    } }), /no source evidence/);
  assert.equal(requests, 2);
});

test('failed API call does not switch models or retry; tool loop and context are bounded', async () => {
  let requests = 0;
  await assert.rejects(investigateQuestion({ question: 'Nations?', language: 'en-US', corpus: corpus(), apiKey: 'test-only', reserveRequest() {},
    fetcher: async () => { requests++; return new Response('', { status: 403 }); } }), /API unavailable/);
  assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(investigateQuestion({ question: 'Nations?', language: 'en-US', corpus: corpus(), apiKey: 'test-only', reserveRequest() {},
    fetcher: async () => { requests++; return readCall(); } }), /limit reached/);
  assert.equal(requests, 6);
  const oversized = corpus(); oversized.catalogue = () => ['a'.repeat(100000)];
  await assert.rejects(investigateQuestion({ question: 'Nations?', language: 'en-US', corpus: oversized, apiKey: 'test-only', reserveRequest() { assert.fail(); }, fetcher() { assert.fail(); } }), /context limit/);
});

test('service enforces allowlist, cooldown and persistent daily quota without live API calls', async t => {
  const directory = temp(t), env = { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only', NATIONS_QUESTION_USER_IDS: userId };
  let clock = Date.now(), apiCalls = 0;
  const fetcher = async url => {
    if (url.startsWith('https://api.github.com/')) return new Response('', { status: 503 });
    assert.equal(url, 'https://api.openai.com/v1/responses');
    apiCalls++; return apiCalls % 2 ? readCall() : answer();
  };
  const service = createQuestionService({ directory, env, fetcher, now: () => clock });
  assert.match(await service.ask({ userId: 'other', language: 'en-US', question: 'Nations rules?' }), /not enabled/);
  assert.equal(apiCalls, 0);
  for (let i = 0; i < 5; i++) {
    assert.match(await service.ask({ userId, question: 'Can Poland sell this advisor?', onAccepted: async () => { assert.equal(apiCalls, i * 2, 'acknowledge before any paid API request'); } }), /AI interpretation/);
    assert.match(await service.ask({ userId, question: 'Can Poland sell this advisor?', onAccepted: async () => assert.fail('Rejected questions must not acknowledge an investigation') }), /limit reached/);
    clock += 60001;
  }
  service.close();
  const restarted = createQuestionService({ directory, env, fetcher, now: () => clock });
  assert.match(await restarted.ask({ userId, question: 'Nations rules?' }), /limit reached/);
  assert.equal(apiCalls, 10);
  const ledger = JSON.parse(readFileSync(join(directory, 'questions/usage.json')));
  assert.equal(ledger.requests, 10); assert.equal(ledger.total, 5);
  assert.equal(JSON.stringify(ledger).includes('advisor'), false);
  clock += dayMs;
  assert.match(await restarted.ask({ userId, question: 'Nations rules?' }), /AI interpretation/);
  restarted.close();
});

test('disabled or corrupt-ledger service performs no network activity', async t => {
  const fetcher = () => assert.fail('network must remain unused');
  const disabled = createQuestionService({ env: { OPENAI_API_KEY: 'test-only' }, fetcher });
  assert.match(await disabled.ask({ language: 'en-US' }), /not enabled/);
  const directory = temp(t);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(directory, 'questions'));
  writeFileSync(join(directory, 'questions/usage.json'), '{}');
  const service = createQuestionService({ directory, env: { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only', NATIONS_QUESTION_USER_IDS: userId }, fetcher });
  assert.match(await service.ask({ userId, language: 'en-US', question: 'Nations rules?' }), /not enabled/);
});

test('global budget blocks a fresh user and broken sources leave the bot available', async t => {
  const directory = temp(t);
  const { mkdirSync } = await import('node:fs');
  const root = join(directory, 'questions'); mkdirSync(root);
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(root, 'usage.json'), JSON.stringify({ day, total: 20, requests: 120, users: {} }));
  const env = { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only', NATIONS_QUESTION_USER_IDS: userId };
  let paidCalls = 0;
  const fetcher = async url => {
    if (url === 'https://api.openai.com/v1/responses') paidCalls++;
    return new Response('', { status: 503 });
  };
  const service = createQuestionService({ directory, env, fetcher });
  const reset = service.resetQuota(userId, userId);
  assert.equal(reset.remaining, 5); assert.equal(reset.total, 20); assert.equal(reset.requests, 120);
  assert.match(await service.ask({ userId, question: 'Nations rules?' }), /limit reached/);
  assert.equal(paidCalls, 0); service.close();
  writeFileSync(join(root, 'tabony-snapshot.json'), '{}');
  const broken = createQuestionService({ directory, env, fetcher });
  assert.match(await broken.ask({ userId, question: 'Nations rules?', language: 'en-US' }), /unavailable/);
  broken.close();
});

test('overlapping questions do not spend twice; shutdown aborts the request', { timeout: 5000 }, async t => {
  const directory = temp(t);
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const service = createQuestionService({ directory,
    env: { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only', NATIONS_QUESTION_USER_IDS: userId },
    fetcher: async (url, options) => {
      if (url.startsWith('https://api.github.com/')) return new Response('', { status: 503 });
      calls++; started();
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
  const first = service.ask({ userId, question: 'Nations rules?' });
  await pending;
  assert.match(await service.ask({ userId, question: 'Nations rules?' }), /already|Another question/);
  assert.equal(calls, 1);
  assert.throws(() => service.resetQuota(userId), /undersöks/, 'Do not race quota resets against a running investigation');
  service.close();
  assert.match(await first, /could not finish/);
});

test('owner quota reset persists, clears only one user and preserves global spending limits', async t => {
  const directory = temp(t), other = '821001820309815368'; let clock = Date.now(), calls = 0; const audit = [];
  const options = { directory, env: { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only', NATIONS_QUESTION_USER_IDS: userId + ',' + other },
    now: () => clock, report: message => audit.push(message), fetcher: async url => {
      if (url.startsWith('https://api.github.com/')) return new Response('', { status: 503 });
      calls++; return calls % 2 ? readCall() : answer();
    } };
  const service = createQuestionService(options);
  await service.ask({ userId: other, question: 'Can Poland sell this advisor?' });
  for (let i = 0; i < 5; i++) { clock += 60001; await service.ask({ userId, question: 'Can Poland sell this advisor?' }); }
  assert.equal(service.quota(userId).used, 5); assert.ok(service.quota(userId).cooldownRemainingMs > 0);
  const before = service.quota(userId), otherBefore = service.quota(other);
  const reset = service.resetQuota(userId, userId);
  assert.equal(reset.used, 0); assert.equal(reset.remaining, 5); assert.equal(reset.cooldownRemainingMs, 0);
  assert.equal(reset.total, before.total); assert.equal(reset.requests, before.requests); assert.deepEqual(service.quota(other), otherBefore);
  assert.equal(audit.filter(message => message.includes('Frågekvot nollställd')).length, 1);
  service.close(); const restarted = createQuestionService(options);
  assert.equal(restarted.quota(userId).remaining, 5);
  assert.match(await restarted.ask({ userId, question: 'Can Poland sell this advisor?' }), /AI interpretation/);
  assert.equal(restarted.quota(userId).used, 1); assert.equal(restarted.quota(userId).total, before.total + 1);
  assert.throws(() => restarted.resetQuota('not-an-id'), /Discord-ID/);
  restarted.close();
});
