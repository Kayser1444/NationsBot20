import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadQuestionCards, createCardLibrary, cardSearchTokens } from '../card-library.mjs';
import { createQuestionCorpus, loadQuestionRulebooks } from '../question-sources.mjs';
import { investigateQuestion } from '../question-agent.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const raw = read('../data/cards/library/entries.json');
const library = loadQuestionCards();
const snapshot = read('../data/question/tabony-snapshot.json');
const faq = read('../data/faq/entries.json');
const corpus = () => createQuestionCorpus(snapshot, faq, loadQuestionRulebooks(), library);
const response = output => new Response(JSON.stringify({ status: 'completed', output: output.map(item => item.type !== 'message' ? item : ({ ...item, content: item.content.map(part => part.type !== 'output_text' ? part : ({ ...part, text: JSON.stringify({ question_language: 'en', answer_language: 'en', english_question: null, parts: [{ text: part.text, english_text: null }] }) })) })) }));
const call = (name, args, id) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });

test('worker event lookup reproduces the staging phrase and ranks actual population gains first', () => {
  const expected = ['Han dynasty', 'Janissaries', 'Pilgrims'];
  for (const query of ['Events that give workers, add workers to supply or player board, recruit worker', 'events gain workers', 'event take worker']) {
    const hits = library.search({ query });
    assert.deepEqual(hits.slice(0, 3).map(hit => hit.name).sort(), expected, query);
    assert.ok(hits.every(hit => hit.type === 'event'), 'explicit event intent must exclude other card types');
    assert.ok(hits.slice(0, 3).every(hit => hit.evidenceKind === 'printed-card'));
  }
  assert.ok(library.search({ query: 'worker', card_type: 'event' }).every(hit => hit.type === 'event'));
  assert.equal(library.search({ query: 'worker', card_type: '../secrets' }).error, 'Unknown card type.');
});

test('agent tool loop can retrieve and read worker-granting events from the logged failed query', async () => {
  let round = 0; const c = corpus();
  const text = await investigateQuestion({ question: 'vilka events kan ge gubbar?', language: 'sv-SE', corpus: c, apiKey: 'test-only', reserveRequest() {},
    fetcher: async (_url, options) => {
      round++; const body = JSON.parse(options.body);
      const schema = body.tools.find(tool => tool.name === 'search_cards').parameters;
      assert.ok(schema.properties.card_type.enum.includes('event'));
      if (round === 1) return response([call('search_cards', { query: 'Events that give workers, add workers to supply or player board, recruit worker', card_type: 'event' }, 'events')]);
      if (round === 2) {
        const hits = JSON.parse(body.input.find(item => item.call_id === 'events' && item.type === 'function_call_output').output);
        assert.deepEqual(hits.slice(0, 3).map(hit => hit.name).sort(), ['Han dynasty', 'Janissaries', 'Pilgrims']);
        return response(hits.slice(0, 3).map((hit, i) => call('read_source', { id: hit.id, start: 1, count: 30 }, 'read' + i)));
      }
      const reads = body.input.filter(item => item.type === 'function_call_output' && item.call_id.startsWith('read')).map(item => JSON.parse(item.output));
      assert.equal(reads.length, 3); assert.ok(reads.every(source => source.evidenceKind === 'printed-card' && /[Tt]ake [12] \[Worker\]/.test(source.excerpt)));
      return response([{ type: 'message', content: [{ type: 'output_text', text: reads.map(source => source.title).join(', ') }] }]);
    } });
  assert.match(text, /Janissaries/); assert.match(text, /Han dynasty/); assert.match(text, /Pilgrims/); assert.equal(round, 3);
});

test('English library covers the card registry and separates printed image evidence from implementation descriptions', () => {
  const catalog = read('../data/cards/catalog.json').cards;
  assert.equal(raw.language, 'en');
  assert.deepEqual([...new Set(library.documents.map(doc => doc.cardId))].sort(), catalog.map(card => card.id).sort());
  assert.equal(library.summary.cards, 526);
  assert.equal(library.summary.searchableEntries, 575);
  assert.equal(library.summary.imageVerifiedCards, 50);
  const printed = library.documents.filter(doc => doc.evidenceKind === 'printed-card');
  assert.equal(printed.length, 99);
  for (const doc of printed) { assert.equal(doc.review, 'image-verified'); assert.match(doc.imageSha256, /^[a-f0-9]{64}$/); }
  const tower = library.documents.find(doc => doc.id === 'cards/PcTw');
  assert.equal(tower.evidenceKind, 'implementation-description');
  assert.match(tower.text, /NOT verified printed card text/);
  assert.ok(tower.text.includes(snapshot.commit));
  assert.ok(library.documents.some(doc => doc.evidenceKind === 'metadata-only' && doc.text.includes('Do not infer an ability')));
});

test('split events retain independent names, targeting and effects', () => {
  const c = corpus();
  const first = c.read({ id: 'cards/FD_HM/a', count: 100 });
  const second = c.read({ id: 'cards/FD_HM/b', count: 100 });
  assert.equal(first.title, 'Feudal dues'); assert.equal(second.title, 'Hajj from Mali');
  assert.equal(first.cardId, second.cardId);
  assert.match(first.excerpt, /No change in player order/);
  assert.equal(first.excerpt.includes('Lose all [Gold] except 2'), false);
  assert.match(second.excerpt, /Least \[Stability\]: Lose all \[Gold\] except 2/);
  assert.match(second.excerpt, /Famine: -2/);
  assert.equal(c.read({ id: '../Reference/Feudal_dues.jpg' }).error, 'Unknown source or invalid line range.');
});

test('description search recognizes English paraphrases and distinguishes keeping two from losing two', () => {
  assert.equal(library.search({ query: 'Which event lets the lowest stability nation keep only two gold?' })[0].id, 'cards/FD_HM/b');
  assert.equal(library.search({ query: 'least stability lose 2 gold and 2 food' })[0].id, 'cards/RL_Ic/b');
  assert.equal(library.search({ query: 'most stability six gold go last' })[0].id, 'cards/AST_GR/b');
  assert.equal(library.search({ query: 'event that ends the game after this round' })[0].id, 'cards/promo-imperium-rex/a');
  assert.equal(library.search({ query: 'Sinking of the Vasa' })[0].id, 'cards/SV_PW/a');
  const ambiguous = library.search({ query: 'first to pass gain books' }).slice(0, 2).map(doc => doc.name).sort();
  assert.deepEqual(ambiguous, ['Romanticism', 'Taoism']);
  assert.ok(library.search({ query: 'advisor on wonder space' }).some(doc => doc.name === 'Porcelain Tower'));
  assert.ok(cardSearchTokens('lose two coins').includes('2'));
  assert.equal(library.search({ query: 'a'.repeat(241) }).error, 'Use a short English card name or effect description.');
  assert.deepEqual(library.search({ query: 'zzzzzzunknown' }), []);
});

test('image reviews cannot silently turn pending or malformed entries into printed rules', () => {
  const pending = structuredClone(raw);
  pending.cards.find(card => card.printed).printed.review.status = 'pending';
  assert.throws(() => createCardLibrary(pending), /Invalid card image review/);
  const duplicate = structuredClone(raw); duplicate.cards.push(duplicate.cards[0]);
  assert.throws(() => createCardLibrary(duplicate), /Invalid card identity/);
  const malformed = structuredClone(raw);
  malformed.cards.find(card => card.printed).printed.effects[0].slot = '../../.env';
  assert.throws(() => createCardLibrary(malformed), /Invalid card effect slot/);
});

test('on-demand card lookup keeps the initial model context small and does not pretend the description snapshot updated daily', () => {
  const next = { ...snapshot, commit: 'a'.repeat(40) };
  const c = createQuestionCorpus(next, faq, loadQuestionRulebooks(), library);
  assert.equal(c.catalogue().some(doc => doc.id === 'cards/index'), true);
  assert.equal(c.catalogue().some(doc => doc.id === 'cards/PcTw'), false);
  assert.equal(c.search({ query: 'Stability' }).some(hit => hit.id.startsWith('cards/')), false);
  const card = c.read({ id: 'cards/PcTw', count: 100 });
  assert.equal(card.implementationCommit, snapshot.commit);
  assert.notEqual(card.implementationCommit, c.commit);
  assert.match(card.excerpt, /Check the current code snapshot/);
  assert.ok(Buffer.byteLength(JSON.stringify(c.catalogue())) < 50000);
});

test('question loop searches described effects, reads the candidate, and cites its English name', async () => {
  let round = 0;
  const answer = await investigateQuestion({ question: 'Vilken händelse gör att lägst stabilitet bara behåller två guld?', language: 'sv-SE',
    corpus: corpus(), apiKey: 'test-only', reserveRequest() {}, fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.ok(body.instructions.includes('translate') || body.tools.some(tool => tool.description.includes('translate')));
      if (++round === 1) return response([call('search_cards', { query: 'lowest stability keep only two gold' }, 'search')]);
      if (round === 2) {
        const hits = JSON.parse(body.input.find(item => item.call_id === 'search' && item.type === 'function_call_output').output);
        assert.equal(hits[0].id, 'cards/FD_HM/b');
        return response([call('read_source', { id: hits[0].id, start: 1, count: 100 }, 'read')]);
      }
      const evidence = JSON.parse(body.input.find(item => item.call_id === 'read' && item.type === 'function_call_output').output);
      assert.equal(evidence.evidenceKind, 'printed-card');
      return response([{ type: 'message', content: [{ type: 'output_text', text: 'Det är Hajj from Mali, på kortet Feudal dues; Hajj from Mali (era II). Källa: cards/FD_HM/b.' }] }]);
    } });
  assert.match(answer, /Hajj from Mali/); assert.equal(round, 3);
});
