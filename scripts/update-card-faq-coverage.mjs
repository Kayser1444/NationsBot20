import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const write = (path, value) => writeFileSync(new URL(path, root), JSON.stringify(value, null, 2) + '\n');
const catalog = read('data/cards/catalog.json');
const supplemental = read('data/cards/supplemental.json');
const index = read('data/faq/index.json');
const entries = read('data/faq/entries.json');
const fold = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const types = { Advisor: 'advisor', Battle: 'battle', Building: 'building', Colony: 'colony',
  'Golden Age': 'golden_age', Military: 'military', War: 'war', Wonder: 'wonder',
  'Natural Wonders': 'natural_wonder', Event: 'event', Dynasties: 'dynasty' };
for (const card of supplemental.cards) {
  const heading = index.items.find(item => item.id === card.faqHeadingId);
  if (!heading || heading.heading !== card.name || heading.age !== card.age) throw new Error('FAQ metadata changed: ' + card.id);
  if (!catalog.cards.some(existing => existing.id === card.id)) catalog.cards.push({ ...card,
    imageUrl: null, faqReviewStatus: 'pending', metadataSource: 'FAQ++ 1.11', sourcePages: heading.sourcePages });
}
if (!catalog.cards.some(card => card.id === 'Turmoil')) catalog.cards.push({ id: 'Turmoil', name: 'Turmoil', aliases: [],
  type: 'turmoil', age: null, imageUrl: 'https://games.tabony.net/static/public/Nations/cards/Turmoil.jpg',
  faqReviewStatus: 'pending', metadataSource: 'FAQ++ 1.11', sourcePages: [8, 9] });
for (const [id, aliases] of Object.entries(supplemental.aliases)) {
  const card = catalog.cards.find(card => card.id === id);
  if (!card) throw new Error('Unknown alias target: ' + id);
  card.aliases = [...new Set([...card.aliases, ...aliases])];
}
const pending = { status: 'pending', reviewer: null, reviewedAt: null, notes: 'Metadata match only; FAQ content and card link require review.' };
const nationAliases = { America: ['USA', 'Amerika'], Arabs: ['Araberna', 'Araber'], China: ['Kina'], Egypt: ['Egypten'],
  Ethiopia: ['Etiopien'], Greece: ['Grekland'], India: ['Indien'], Japan: [], Korea: [], Mali: [], Mongolia: ['Mongoliet'],
  Persia: ['Persien'], Poland: ['Polen'], Portugal: [], Rome: ['Rom'], Venice: ['Venedig'], Vikings: ['Vikingar', 'Vikingarna'] };
for (const nation of catalog.cards.filter(card => card.type === 'nation')) {
  nation.aliases = [...new Set([...nation.aliases, ...nationAliases[nation.name]])];
  for (const entry of entries.entries) {
    const own = entry.category === 'nation' && entry.heading.replace(/ B-side$/, '') === nation.name;
    const dynasty = entry.category === 'dynasty' && entry.heading.startsWith(nation.name + ':');
    if ((own || dynasty) && !entry.cardLinks.some(link => link.cardId === nation.id)) {
      entry.cardLinks.push({ cardId: nation.id, relation: own ? 'own_entry' : 'general_rule', review: { ...pending } });
    }
  }
}
const coverage = [];
for (const item of index.items) {
  const type = types[item.section];
  if (!type || item.heading === item.section || item.section === 'Golden Age' && item.heading === 'Bonus') continue;
  // This is a wrapped continuation of the preceding Ostafrika heading, not another card.
  if (item.id === 'colony-orientale-in-translations-1-4') continue;
  const name = item.section === 'Dynasties' ? item.heading.split(':').at(-1).trim() : item.heading;
  const names = [name];
  if (name.startsWith('Ostafrika (')) names.push('Ostafrika');
  const candidates = catalog.cards.filter(card => card.type === type &&
    (item.age === null || card.age === item.age) && [card.name, ...card.aliases].some(alias => names.some(name => fold(alias) === fold(name))));
  const ids = candidates.map(card => card.id);
  item.cardId = ids.length === 1 ? ids[0] : null;
  item.cardIds = ids;
  coverage.push({ headingId: item.id, heading: item.heading, section: item.section, sourcePages: item.sourcePages, cardIds: ids });
  const entry = entries.entries.find(entry => entry.id === item.id);
  if (entry) for (const cardId of ids) {
    if (!entry.cardLinks.some(link => link.cardId === cardId && link.relation === 'own_entry')) entry.cardLinks.push({ cardId, relation: 'own_entry', review: { ...pending } });
  }
}
// Record named references too, without changing any previous review decisions.
for (const entry of entries.entries) for (const card of catalog.cards) {
  const mentioned = [card.name, ...card.aliases].some(name => {
    const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![a-z0-9])' + pattern + '(?![a-z0-9])', 'i').test(entry.sourceText);
  });
  if (mentioned && !entry.cardLinks.some(link => link.cardId === card.id)) entry.cardLinks.push({ cardId: card.id, relation: 'cross_reference', review: { ...pending } });
}
for (const card of catalog.cards) card.enabled = true;
catalog.cards.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
write('data/cards/catalog.json', catalog);
write('data/cards/faq-coverage.json', { schemaVersion: 1, sourceId: supplemental.sourceId,
  note: 'Inventory coverage only. All newly added FAQ links remain pending. Multiple IDs may represent starting-board variants.', items: coverage });
write('data/faq/index.json', index);
write('data/faq/entries.json', entries);
console.log(JSON.stringify({ cards: catalog.cards.length, headings: coverage.length,
  unmapped: coverage.filter(item => !item.cardIds.length) }, null, 2));
