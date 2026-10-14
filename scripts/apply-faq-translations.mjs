import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFaqReview } from './write-faq-review.mjs';
const root = new URL('../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const translations = read('data/faq/translations-sv.json');
const source = read('data/faq/sources.json').sources[0];
const database = read('data/faq/entries.json');
const entryById = new Map(database.entries.map(entry => [entry.id, entry]));
if (source.sha256 !== translations.sourceSha256) throw new Error('Translations belong to another FAQ PDF.');
if (new Set(translations.translations.map(item => item.entryId)).size !== translations.translations.length ||
    new Set(translations.headingTranslations.map(item => item.entryId)).size !== translations.headingTranslations.length) {
  throw new Error('Duplicate FAQ translation IDs.');
}
for (const item of translations.translations) {
  const entry = entryById.get(item.entryId);
  const original = entry?.bullets.find(bullet => bullet.id === item.sourceBulletId && bullet.language === 'en-US');
  if (!entry || hash(entry.sourceText) !== item.sourceTextSha256 || !original || hash(original.text) !== item.sourceBulletSha256 || !item.text.trim()) {
    throw new Error('Translation source changed: ' + item.entryId);
  }
  const id = item.entryId + '-sv';
  const existing = entry.bullets.find(bullet => bullet.id === id);
  // Importing never overwrites a later approval or rejection of the translation.
  const bullet = { id, language: 'sv-SE', kind: 'translation', text: item.text,
    review: existing?.review ?? { status: 'pending', reviewer: null, reviewedAt: null,
      notes: 'Swedish translation by Codex; English source preserved and protected by SHA-256.' } };
  if (existing) {
    if (existing.text !== item.text && existing.review.status !== 'pending') throw new Error('Reviewed translation changed: ' + id);
    Object.assign(existing, bullet);
  } else entry.bullets.push(bullet);
}
for (const item of translations.headingTranslations) {
  const entry = entryById.get(item.entryId);
  if (!entry || hash(entry.heading) !== item.sourceHeadingSha256 || !item.text.trim()) throw new Error('Translation heading changed: ' + item.entryId);
  entry.headingSv = item.text;
}
for (const entry of database.entries) {
  const english = entry.bullets.filter(bullet => bullet.language === 'en-US');
  const swedish = entry.bullets.filter(bullet => bullet.language === 'sv-SE');
  if (english.length !== swedish.length) throw new Error('Incomplete Swedish FAQ: ' + entry.id);
}
writeFileSync(new URL('data/faq/entries.json', root), JSON.stringify(database, null, 2) + '\n');
writeFaqReview(database);
console.log(`Applied ${translations.translations.length} translations; all ${database.entries.length} FAQ entries are bilingual.`);
