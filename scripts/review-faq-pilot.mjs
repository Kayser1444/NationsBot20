import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const write = (path, value) => writeFileSync(new URL(path, root), JSON.stringify(value, null, 2) + '\n');
const pilot = read('data/faq/pilot-review.json');
const source = read('data/faq/sources.json').sources[0];
const database = read('data/faq/entries.json');
const catalog = read('data/cards/catalog.json');
if (source.sha256 !== pilot.sourceSha256) throw new Error('Pilot review belongs to a different source PDF.');
const review = { status: 'approved', reviewer: pilot.reviewer, reviewedAt: pilot.reviewedAt, notes: pilot.notes };
for (const [id, selected] of Object.entries(pilot.entries)) {
  const entry = database.entries.find(entry => entry.id === id);
  if (!entry || createHash('sha256').update(entry.sourceText).digest('hex') !== selected.sourceTextSha256) {
    throw new Error('Reviewed source passage changed: ' + id);
  }
  entry.review = { ...review };
  entry.bullets = selected.bullets.flatMap((bullet, index) => ['sv', 'en'].map(language => ({
    id: `${id}-${index + 1}-${language}`, language: language === 'sv' ? 'sv-SE' : 'en-US', kind: 'summary',
    text: bullet[language], review: { ...review },
  })));
  for (const link of selected.cardLinks) {
    const existing = entry.cardLinks.find(item => item.cardId === link.cardId && item.relation === link.relation);
    if (existing) existing.review = { ...review };
    else entry.cardLinks.push({ ...link, review: { ...review } });
  }
}
for (const [id, selected] of Object.entries(pilot.cards)) {
  const card = catalog.cards.find(card => card.id === id);
  if (!card) throw new Error('Unknown reviewed card: ' + id);
  Object.assign(card, selected);
}
write('data/faq/entries.json', database);
write('data/cards/catalog.json', catalog);
const approved = database.entries.filter(entry => entry.review.status === 'approved');
const lines = ['# FAQ++ 1.11: genomgång', '', `Importerade textposter: ${database.entries.length}. Källkontrollerat piloturval: ${approved.length}.`,
  '', 'Pilotens svenska och engelska sammanfattningar samt kortkopplingar har kontrollerats av Codex mot originalet. Övriga poster är pending. Ingen användargranskning antyds.',
  '', 'Originalets PDF-textlager har felaktiga ligaturer (t.ex. “efect”, “frst”). Råtexten bevaras; sammanfattningarna använder normal stavning.', ''];
for (const entry of database.entries) {
  lines.push(`## ${entry.id}: ${entry.heading}`, '', `Sida ${entry.sourcePages.join(', ')} · ${entry.category} · ${entry.review.status}`, '',
    '### Originaltext', '', entry.sourceText, '', '### Svarspunkter', '',
    ...entry.bullets.map(bullet => `- ${bullet.language} (${bullet.kind}, ${bullet.review.status}): ${bullet.text}`), '',
    '### Kortkopplingar', '', ...entry.cardLinks.map(link => `- ${link.cardId} · ${link.relation} · ${link.review.status}`), '',
    `Hänvisningar: ${entry.relatedEntryIds.join(', ') || 'Inga identifierade'}`, '', '- [ ] Användarens innehållsgranskning', '');
}
writeFileSync(new URL('data/faq/review.md', root), lines.join('\n'));
console.log(`Applied ${approved.length} source-checked pilot entries; remaining ${database.entries.length - approved.length} entries pending.`);
