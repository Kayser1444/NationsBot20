import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { writeFaqReview } from './write-faq-review.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const locales = { sv: 'sv-SE', de: 'de', fr: 'fr', es: 'es-ES', zh: 'zh-CN' };

// Mutate only the supplied in-memory database. The CLI saves after every bundle validates.
export function applyFaqTranslations(database, source, bundle) {
  const language = bundle.language;
  const code = Object.keys(locales).find(code => locales[code] === language);
  if (!code || bundle.schemaVersion !== 1 || source.sha256 !== bundle.sourceSha256) throw new Error('Translations belong to another FAQ source or language.');
  const entryById = new Map(database.entries.map(entry => [entry.id, entry]));
  const unique = (items, key) => new Set(items.map(key)).size === items.length;
  if (!unique(bundle.translations, item => item.sourceBulletId) || !unique(bundle.headingTranslations, item => item.entryId)) throw new Error('Duplicate FAQ translation IDs.');
  for (const item of bundle.translations) {
    const entry = entryById.get(item.entryId);
    const original = entry?.bullets.find(bullet => bullet.id === item.sourceBulletId && bullet.language === 'en-US');
    if (!entry || hash(entry.sourceText) !== item.sourceTextSha256 || !original || hash(original.text) !== item.sourceBulletSha256 || !item.text?.trim()) throw new Error('Translation source changed: ' + item.entryId);
    const versions = value => value.match(/\[\d+\.\d+\]/g) ?? [];
    if (JSON.stringify(versions(original.text)) !== JSON.stringify(versions(item.text))) throw new Error('Translation version references changed: ' + item.entryId);
    const id = code === 'sv' ? item.entryId + '-sv' : item.sourceBulletId.replace(/-en$/, '') + '-' + code;
    const existing = entry.bullets.find(bullet => bullet.id === id);
    if (existing && existing.language !== language) throw new Error('Translation ID conflicts with another language: ' + id);
    const bullet = { id, language, kind: 'translation', text: item.text,
      review: existing?.review ?? { status: 'pending', reviewer: null, reviewedAt: null,
        notes: `${bundle.provenance} English sources protected by SHA-256; no automatic content approval.` } };
    if (existing) {
      if (existing.text !== item.text && existing.review.status !== 'pending') throw new Error('Reviewed translation changed: ' + id);
      Object.assign(existing, bullet);
    } else entry.bullets.push(bullet);
  }
  for (const item of bundle.headingTranslations) {
    const entry = entryById.get(item.entryId);
    if (!entry || hash(entry.heading) !== item.sourceHeadingSha256 || !item.text?.trim()) throw new Error('Translation heading changed: ' + item.entryId);
    if (language === 'sv-SE') entry.headingSv = item.text;
    else entry.headingTranslations = { ...entry.headingTranslations, [language]: item.text };
  }
  for (const entry of database.entries) {
    const english = entry.bullets.filter(bullet => bullet.language === 'en-US');
    const localized = entry.bullets.filter(bullet => bullet.language === language);
    if (english.length !== localized.length) throw new Error(`Incomplete ${language} FAQ: ${entry.id}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL('../', import.meta.url);
  const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
  const source = read('data/faq/sources.json').sources[0];
  const database = read('data/faq/entries.json');
  // Explicit sv preserves the earlier Swedish-only import workflow.
  const selected = process.argv.slice(2);
  const codes = selected.length ? selected : Object.keys(locales);
  for (const code of codes) {
    if (!Object.hasOwn(locales, code)) throw new Error('Unknown FAQ language: ' + code);
    const bundle = read(`data/faq/translations-${code}.json`);
    if (bundle.language !== locales[code]) throw new Error('FAQ language file mismatch: ' + code);
    applyFaqTranslations(database, source, bundle);
    console.log(`Applied ${bundle.translations.length} ${bundle.language} translations.`);
  }
  writeFileSync(new URL('data/faq/entries.json', root), JSON.stringify(database, null, 2) + '\n');
  writeFaqReview(database);
}
