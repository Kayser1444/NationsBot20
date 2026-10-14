import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardBank, createCardBank } from '../card-bank.mjs';
const read = path => JSON.parse(readFileSync(new URL('../data/' + path, import.meta.url), 'utf8'));
const fixtures = () => ({ catalog: read('cards/catalog.json'), sources: read('faq/sources.json'), entries: read('faq/entries.json') });
const content = reply => reply.messages.flatMap(message => [message.content, ...(message.embeds ?? []).map(embed => embed.description ?? '')]).join('\n');
const allPages = (bank, language) => Array.from({ length: bank.render('PcTw', language).faqPageCount },
  (_, faqPage) => bank.render('PcTw', language, { faqPage }));
function assertMessageLimits(reply) {
  assert.equal(reply.messages.length, 1, 'opening and closing must update a single message');
  for (const message of reply.messages) {
    assert.ok(message.content.length <= 2000);
    assert.ok(message.embeds.length <= 10);
    let total = 0;
    for (const embed of message.embeds) {
      assert.ok((embed.description?.length ?? 0) <= 4096);
      total += (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
    }
    assert.ok(total <= 6000);
    for (const row of message.components) for (const button of row.components) assert.ok(button.custom_id.length <= 100);
    assert.deepEqual(message.allowed_mentions, { parse: [], users: [], roles: [] });
  }
}

test('FAQ import preserves column continuations, wrapped names and every extracted line', () => {
  const document = read('faq/document.json');
  assert.equal(document.blocks.reduce((sum, block) => sum + block.lines.length, 0) + document.context.length, document.extractedLines);
  const { entries } = read('faq/entries.json');
  const resources = entries.find(entry => entry.id === 'general-resource-loss');
  assert.deepEqual(resources.sourcePages, [1, 2]);
  assert.match(resources.sourceText, /In total, you have lost 1 VP/);
  const poland = entries.find(entry => entry.id === 'dynasties-poland-polish-lithuanian-commonwealth');
  assert.match(poland.sourceText, /Does not afect Advisor on Porcelain Tower/);
  assert.ok(!entries.some(entry => entry.heading === 'Commonwealth'));
  assert.deepEqual(entries.find(entry => entry.sourceText.includes('column with a war again?')).sourcePages, [9, 10]);
  assert.equal(read('faq/sources.json').sources[0].reviewComplete, false);
});

test('Porcelain Tower shows its own rules and every named cross-reference with sources in both languages', () => {
  const corpus = read('faq/entries.json').entries;
  const expected = corpus.filter(entry => entry.sourceText.includes('Porcelain Tower')).map(entry => entry.id);
  for (const language of ['sv-SE', 'en-US']) {
    const reply = cardBank.render('  porcelain   TOWER ', language);
    assert.equal(reply.ok, true);
    assert.ok(reply.entryIds.includes('wonder-wonder'));
    for (const id of expected) assert.ok(reply.entryIds.includes(id), 'missing named reference: ' + id);
    assert.equal(reply.pointCount, 13);
    assert.equal(reply.messages[0].embeds.length, 2, 'FAQ starts collapsed');
    assert.ok(!content(reply).includes('French Revolution'));
    assert.match(reply.messages[0].components[0].components[0].label, /13/);
    const pages = allPages(cardBank, language);
    const text = pages.map(content).join('\n');
    assert.match(text, /Poland: Polish-Lithuanian Commonwealth/);
    assert.match(text, /FAQ\+\+ 1.11/);
    assert.match(reply.messages[0].embeds[1].description, /II/);
    assert.ok(!text.includes('||'), 'FAQ is ordinary text, without spoilers');
    for (const page of [reply, ...pages]) assertMessageLimits(page);
  }
  assert.deepEqual(cardBank.autocomplete('porc').map(option => option.value), ['PcTw']);
  assert.equal(cardBank.render('Porc').ok, false, 'partial names require an explicit autocomplete choice');
  assert.equal(cardBank.render('Titanic').ok, false, 'unreviewed card metadata is not silently exposed');
});

test('pending source text, summary or link is excluded independently', () => {
  for (const level of ['source', 'bullet', 'link']) {
    const data = fixtures();
    const entry = data.entries.entries.find(entry => entry.id === 'event-anarchism');
    if (level === 'source') entry.review.status = 'pending';
    if (level === 'bullet') for (const bullet of entry.bullets) bullet.review.status = 'pending';
    if (level === 'link') entry.cardLinks.find(link => link.cardId === 'PcTw').review.status = 'pending';
    const text = allPages(createCardBank(data), 'sv-SE').map(content).join('\n');
    assert.ok(!text.includes('Anarchism'));
  }
});

test('long FAQ points survive pagination with repeated source labels and no empty pages', () => {
  const data = fixtures();
  const entry = data.entries.entries.find(entry => entry.id === 'event-anarchism');
  const tokens = Array.from({ length: 800 }, (_, i) => 'unique' + i);
  entry.bullets.find(bullet => bullet.language === 'sv-SE').text = tokens.join(' ') + ' || literal spoiler marks';
  const bank = createCardBank(data);
  const pages = allPages(bank, 'sv-SE');
  assert.ok(pages.length > 2);
  const text = pages.map(content).join('\n');
  for (const token of tokens) assert.match(text, new RegExp('\\b' + token + '\\b'));
  assert.ok(text.includes('\\|\\| literal spoiler marks'));
  for (const page of pages) {
    assertMessageLimits(page);
    assert.match(page.messages[0].embeds[2].description, /\n- \*\*/);
    const close = page.messages[0].components[0].components[0];
    assert.equal(bank.renderButton(close.custom_id).messages[0].embeds.length, 2);
  }
  const firstButtons = pages[0].messages[0].components[0].components;
  assert.equal(firstButtons[1].disabled, true);
  assert.equal(firstButtons[2].disabled, false);
  assert.equal(pages.at(-1).messages[0].components[0].components[2].disabled, true);
  assert.deepEqual(bank.renderButton(firstButtons[2].custom_id).messages, pages[1].messages);
});

test('button IDs retain language and support open, close and fresh bank instances', () => {
  const closed = cardBank.render('PcTw', 'en-US');
  const openId = closed.messages[0].components[0].components[0].custom_id;
  const opened = createCardBank(fixtures()).renderButton(openId);
  assert.match(content(opened), /English summary/);
  const closeId = opened.messages[0].components[0].components[0].custom_id;
  assert.deepEqual(cardBank.renderButton(closeId).messages, closed.messages);
  assert.deepEqual(cardBank.renderButton(openId).messages, opened.messages, 'repeated open clicks are idempotent');
  for (const id of ['cardfaq:2:PcTw:en-US:0', 'cardfaq:1:PcTw:fr:0', 'cardfaq:1:PcTw:en-US:-1', 'other:1:PcTw:en-US:0']) {
    assert.equal(cardBank.renderButton(id), null);
  }
  assert.equal(cardBank.renderButton('cardfaq:1:PcTw:en-US:9999').ok, false);
  assert.equal(cardBank.renderButton('cardfaq:1:Titanic:en-US:0').ok, false);
});
