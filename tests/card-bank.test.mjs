import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

test('all FAQ entries have Swedish translations tied to their unchanged English sources', () => {
  const entries = read('faq/entries.json').entries;
  const translations = read('faq/translations-sv.json');
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(translations.sourceSha256, read('faq/sources.json').sources[0].sha256);
  assert.equal(translations.translations.length, 206);
  for (const entry of entries) {
    const english = entry.bullets.filter(bullet => bullet.language === 'en-US');
    const swedish = entry.bullets.filter(bullet => bullet.language === 'sv-SE');
    assert.ok(swedish.length, entry.id);
    assert.equal(swedish.length, english.length, entry.id);
    for (const bullet of swedish) assert.ok(bullet.text.trim(), bullet.id);
    if (entry.id.startsWith('faq-q-') || entry.category === 'card_type') assert.ok(entry.headingSv, entry.id);
  }
  for (const item of translations.translations) {
    const entry = entries.find(entry => entry.id === item.entryId);
    const original = entry.bullets.find(bullet => bullet.id === item.sourceBulletId);
    assert.equal(hash(entry.sourceText), item.sourceTextSha256, item.entryId);
    assert.equal(hash(original.text), item.sourceBulletSha256, item.entryId);
    const versions = value => value.match(/\[\d+\.\d+\]/g) ?? [];
    assert.deepEqual(versions(item.text), versions(original.text), item.entryId);
  }
  const faq = cardBank.render('Turmoil', 'sv-SE', { faqPage: 0 });
  assert.match(content(faq), /Kan skuggan ta Turmoil/);
  assert.ok(!content(faq).includes('Q: Can the shadow'));
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
    assert.match(text, language === 'sv-SE' ? /Polen: Polish-Lithuanian Commonwealth/ : /Poland: Polish-Lithuanian Commonwealth/);
    assert.match(text, /FAQ\+\+ 1.11/);
    assert.match(reply.messages[0].embeds[1].description, /II/);
    assert.ok(!text.includes('||'), 'FAQ is ordinary text, without spoilers');
    for (const page of [reply, ...pages]) assertMessageLimits(page);
  }
  assert.deepEqual(cardBank.autocomplete('porc').map(option => option.value), ['PcTw']);
  assert.equal(cardBank.render('Porc').ok, false, 'partial names require an explicit autocomplete choice');
  assert.equal(cardBank.render('Titanic').ok, true, 'available images do not require FAQ review');
});

test('rejected source text, summary or link is excluded independently', () => {
  for (const level of ['source', 'bullet', 'link']) {
    const data = fixtures();
    const entry = data.entries.entries.find(entry => entry.id === 'event-anarchism');
    if (level === 'source') entry.review.status = 'rejected';
    if (level === 'bullet') for (const bullet of entry.bullets) bullet.review.status = 'rejected';
    if (level === 'link') entry.cardLinks.find(link => link.cardId === 'PcTw').review.status = 'rejected';
    const text = allPages(createCardBank(data), 'sv-SE').map(content).join('\n');
    assert.ok(!text.includes('Anarchism'));
  }
});

test('every FAQ card heading is inventoried and all localized points retain citations without a disclaimer', () => {
  const { catalog, entries } = fixtures();
  const coverage = read('cards/faq-coverage.json');
  assert.equal(coverage.items.length, 479);
  const ids = new Set(catalog.cards.map(card => card.id));
  for (const item of coverage.items) {
    assert.ok(item.cardIds.length, item.heading);
    for (const id of item.cardIds) assert.ok(ids.has(id), item.heading + ': ' + id);
  }
  for (const card of catalog.cards) {
    const reply = cardBank.render(card.id, 'sv-SE');
    assert.equal(reply.ok, true, card.id);
    assert.equal(reply.messages[0].embeds[0].title, card.name);
    assertMessageLimits(reply);
    const image = reply.messages[0].embeds[0].image;
    if (image) {
      assert.equal(card.imageCheck.status, 200, card.id);
      assert.equal(image.url, card.imageCheck.url);
    } else assert.match(content(reply), /Kortbilden är inte tillgänglig/);
    for (const language of ['sv-SE', 'en-US']) {
      const localized = cardBank.render(card.id, language);
      const pages = Array.from({ length: localized.faqPageCount }, (_, faqPage) => cardBank.render(card.id, language, { faqPage }));
      for (const page of pages) {
        assertMessageLimits(page);
        assert.ok(!/FAQ-text och kortkopplingar|not been fully reviewed|Engelskt original/.test(content(page)));
        if (localized.pointCount) {
          assert.match(page.messages[0].embeds[2].description, /\[FAQ\+\+ 1\.11\]\(<https:\/\/boardgamegeek\.com\/filepage\/96855\/faq-official>\)/);
          assert.match(page.messages[0].embeds[2].description, language === 'sv-SE' ? / · s\. \d/ : / · p\. \d/);
        }
      }
      assert.equal(localized.pointCount, cardBank.render(card.id, language === 'sv-SE' ? 'en-US' : 'sv-SE').pointCount, card.id);
      if (localized.pointCount) {
        assert.ok(!localized.messages[0].components[0].components[0].disabled, card.id);
      }
      const direct = entries.entries.filter(entry => entry.cardLinks.some(link => link.cardId === card.id && ['pending', 'approved'].includes(link.review.status)));
      for (const entry of direct) assert.ok(localized.entryIds.includes(entry.id), card.id + ': ' + entry.id);
    }
  }
  assert.equal(entries.entries.filter(entry => entry.review.status === 'approved').length, 10);
  const cabin = cardBank.render("Tom’s Cabin");
  assert.equal(cabin.cardId, 'UTC');
  assert.match(cabin.messages[0].embeds[0].image.url, /UTC\.jpg$/);
  assert.equal(cabin.pointCount, 2);
  const opened = cardBank.render('UTC', 'sv-SE', { faqPage: 0 });
  assert.match(content(opened), /utplaceringskostnad på 1 sten/);
  assert.match(content(opened), /Guldåldersbonus/);
  assert.ok(!content(opened).includes('Remove all Buildings'));
  const english = cardBank.render('UTC', 'en-US', { faqPage: 0 });
  assert.match(content(english), /Remove all Buildings/);
  for (const name of ['Nikola Tesla', 'Hagia Sophia', 'Kremlin', 'Mechanical Turk', 'Hussar', 'Turmoil', 'Siberia 2']) {
    assert.equal(cardBank.render(name).ok, true, name);
  }
});

test('pending states remain pending, related rules are deduplicated, and unavailable review states stay hidden', () => {
  const data = fixtures();
  const entry = data.entries.entries.find(entry => entry.id === 'golden-age-uncle-tom-s-cabin');
  const bonus = data.entries.entries.find(entry => entry.id === 'golden-age-bonus');
  entry.relatedEntryIds.push(bonus.id);
  bonus.relatedEntryIds.push(entry.id);
  const before = JSON.stringify(data);
  const bank = createCardBank(data);
  const reply = bank.render('UTC', 'sv-SE', { faqPage: 0 });
  assert.equal(reply.pointCount, 2);
  assert.equal(new Set(reply.entryIds).size, reply.entryIds.length);
  assert.equal(JSON.stringify(data), before, 'display must not approve or modify source data');
  for (const status of ['rejected', 'unknown']) {
    entry.review.status = status;
    const hidden = createCardBank(data).render('UTC', 'sv-SE', { faqPage: 0 });
    assert.ok(!content(hidden).includes('utplaceringskostnad'));
    assert.equal(hidden.pointCount, 1);
  }
  const sejong = cardBank.render('SjGr', 'sv-SE', { faqPage: 0 });
  assert.ok(sejong.entryIds.includes('golden-age-bonus'), 'an explicit reference includes its rule');
  assert.equal(cardBank.render('Aqd').pointCount, 0, 'an empty heading is not a fabricated rule');
});

test('large-catalog suggestions disambiguate variants and keep exact matches ahead of partial matches', () => {
  const choices = cardBank.autocomplete('');
  assert.equal(choices.length, 25);
  assert.ok(choices.every(choice => choice.name.length <= 100));
  assert.equal(new Set(choices.map(choice => choice.value)).size, 25);
  assert.deepEqual(cardBank.autocomplete('three kingdoms').map(choice => choice.value).sort(), ['RTK', 'ThKd']);
  assert.equal(cardBank.resolve('Three Kingdoms'), null);
  assert.equal(cardBank.render('RTK').cardId, 'RTK');
  assert.equal(cardBank.render('ThKd').cardId, 'ThKd');
  assert.equal(cardBank.render('Aqueduct').cardId, 'Aqd', 'progress card is preferred over its starting variant');
  assert.equal(cardBank.render('Rome Aqueduct').cardId, 'R_Aqd');
  assert.equal(cardBank.resolve('Farm'), null, 'starting board variants require an explicit choice');
  assert.match(cardBank.autocomplete('China Farm')[0].name, /China.*Startkort|China.*Starting card/);
  assert.equal(cardBank.autocomplete('Tom’s Cabin')[0].value, 'UTC');
  assert.equal(cardBank.autocomplete('Tesla')[0].value, 'faq-nikola-tesla');
  assert.equal(cardBank.autocomplete('no such card 123456').length, 0);
  const data = fixtures();
  data.catalog.cards.find(card => card.id === 'PcTw').imageUrl = 'https://example.com/card.jpg';
  assert.throws(() => createCardBank(data), /Invalid card image/);
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
  assert.match(content(opened), /FAQ\+\+ 1.11.*points/);
  const closeId = opened.messages[0].components[0].components[0].custom_id;
  assert.deepEqual(cardBank.renderButton(closeId).messages, closed.messages);
  assert.deepEqual(cardBank.renderButton(openId).messages, opened.messages, 'repeated open clicks are idempotent');
  for (const id of ['cardfaq:2:PcTw:en-US:0', 'cardfaq:1:PcTw:fr:0', 'cardfaq:1:PcTw:en-US:-1', 'other:1:PcTw:en-US:0']) {
    assert.equal(cardBank.renderButton(id), null);
  }
  assert.equal(cardBank.renderButton('cardfaq:1:PcTw:en-US:9999').ok, false);
  assert.equal(cardBank.renderButton('cardfaq:1:missing-card:en-US:0').ok, false);
});
