import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyFaqTranslations } from '../scripts/apply-faq-translations.mjs';
import { cardBank } from '../card-bank.mjs';
const read = path => JSON.parse(readFileSync(new URL('../data/' + path, import.meta.url), 'utf8'));
const languages = { de: 'de', fr: 'fr', es: 'es-ES', zh: 'zh-CN' };
const hash = value => createHash('sha256').update(value).digest('hex');
const output = reply => reply.messages.flatMap(message => (message.embeds ?? []).map(embed => embed.description ?? '')).join('\n');

test('all FAQ languages preserve sources, references, names and separate review decisions', () => {
  const database = read('faq/entries.json'), source = read('faq/sources.json').sources[0];
  const cardNames = new Set(read('cards/catalog.json').cards.map(card => card.name));
  for (const [code, language] of Object.entries(languages)) {
    const bundle = read(`faq/translations-${code}.json`);
    assert.equal(bundle.language, language);
    assert.equal(bundle.sourceSha256, source.sha256);
    assert.equal(bundle.translations.length, 219);
    for (const item of bundle.translations) {
      const entry = database.entries.find(entry => entry.id === item.entryId);
      const original = entry.bullets.find(bullet => bullet.id === item.sourceBulletId);
      const translated = entry.bullets.find(bullet => bullet.id === item.sourceBulletId.replace(/-en$/, '') + '-' + code);
      assert.equal(hash(entry.sourceText), item.sourceTextSha256);
      assert.equal(hash(original.text), item.sourceBulletSha256);
      assert.equal(translated.text, item.text);
      assert.equal(translated.language, language);
      assert.equal(translated.review.status, 'pending');
      assert.deepEqual(item.text.match(/\[\d+\.\d+\]/g), original.text.match(/\[\d+\.\d+\]/g));
      assert.doesNotMatch(item.text, /ZXQ\s*\d|QXZ|\[\[FAQ\d/);
      for (const name of cardNames) {
        if (name.length > 3 && original.text.includes(name)) assert.ok(item.text.includes(name), `${language} lost ${name} in ${entry.id}`);
      }
    }
    for (const entry of database.entries) {
      assert.equal(entry.bullets.filter(b => b.language === language).length, entry.bullets.filter(b => b.language === 'en-US').length);
      if (entry.id.startsWith('faq-q-') || entry.category === 'card_type') assert.ok(entry.headingTranslations?.[language]);
    }
  }
});

test('FAQ import is idempotent and rejects stale sources, duplicates and overwrites of reviewed translations', () => {
  const source = read('faq/sources.json').sources[0], bundle = read('faq/translations-fr.json');
  const database = read('faq/entries.json');
  const before = structuredClone(database);
  applyFaqTranslations(database, source, bundle);
  assert.deepEqual(database, before);
  const stale = structuredClone(bundle); stale.translations[0].sourceBulletSha256 = 'changed';
  assert.throws(() => applyFaqTranslations(structuredClone(database), source, stale), /source changed/);
  const duplicate = structuredClone(bundle); duplicate.translations.push(duplicate.translations[0]);
  assert.throws(() => applyFaqTranslations(structuredClone(database), source, duplicate), /Duplicate/);
  const reviewed = structuredClone(database);
  const item = bundle.translations[0];
  const translated = reviewed.entries.find(e => e.id === item.entryId).bullets.find(b => b.language === 'fr');
  translated.review.status = 'approved';
  const changed = structuredClone(bundle); changed.translations[0].text += ' Modified.';
  assert.throws(() => applyFaqTranslations(reviewed, source, changed), /Reviewed translation changed/);
  const incomplete = structuredClone(bundle); incomplete.translations.pop();
  const fresh = structuredClone(database); for (const entry of fresh.entries) entry.bullets = entry.bullets.filter(b => b.language !== 'fr');
  assert.throws(() => applyFaqTranslations(fresh, source, incomplete), /Incomplete fr FAQ/);
});

test('every card and nation renders all translated FAQ points with citations within Discord limits', () => {
  const cards = read('cards/catalog.json').cards;
  for (const language of Object.values(languages)) {
    for (const card of cards) {
      const initial = cardBank.render(card.id, language);
      if (!initial.ok) continue;
      assert.equal(initial.pointCount, cardBank.render(card.id, 'en-US').pointCount, `${language}:${card.id}`);
      for (let faqPage = 0; faqPage < initial.faqPageCount; faqPage++) {
        const reply = cardBank.render(card.id, language, { faqPage });
        const message = reply.messages[0];
        assert.equal(reply.ok, true);
        assert.equal(reply.messages.length, 1);
        assert.ok(message.embeds.length <= 10);
        let total = 0;
        for (const embed of message.embeds) {
          assert.ok((embed.description?.length ?? 0) <= 4096);
          total += (embed.description?.length ?? 0) + (embed.title?.length ?? 0);
        }
        assert.ok(total <= 6000, `${language}:${card.id}:${faqPage}`);
        assert.match(output(reply), /FAQ\+\+ 1.11/);
        assert.match(output(reply), /https:\/\/boardgamegeek.com\/filepage\/96855\/faq-official/);
      }
    }
  }
});

test('FAQ buttons retain each new language and render translated text rather than English fallback', () => {
  const expected = { de: /Berater/, fr: /conseiller/i, 'es-ES': /consejero/i, 'zh-CN': /顾问/ };
  for (const language of Object.values(languages)) {
    const closed = cardBank.render('PcTw', language, {faqPage:null});
    const opened = cardBank.renderButton(closed.messages[0].components[0].components[0].custom_id);
    assert.ok(opened.ok);
    assert.match(output(opened), expected[language]);
    assert.doesNotMatch(output(opened), /If an effect removes your Advisor/);
    assert.deepEqual(cardBank.renderButton(opened.messages[0].components[0].components[0].custom_id).messages, closed.messages);
  }
});
