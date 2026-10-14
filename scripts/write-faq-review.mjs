import { writeFileSync } from 'node:fs';

export function writeFaqReview(database) {
  const approved = database.entries.filter(entry => entry.review.status === 'approved');
  const localized = database.entries.filter(entry => entry.bullets.some(bullet => bullet.language === 'sv-SE'));
  const lines = ['# FAQ++ 1.11: genomgång', '', `Importerade textposter: ${database.entries.length}. Källkontrollerat piloturval: ${approved.length}.`,
    '', 'Pilotens svenska och engelska sammanfattningar samt kortkopplingar har kontrollerats av Codex mot originalet. Övriga poster är pending. Ingen användargranskning antyds.',
    '', `Svenska svarspunkter finns för ${localized.length} poster. Engelska originaltexter och granskningsbeslut bevaras. Översättningarnas koppling till originalet skyddas av SHA-256 i translations-sv.json.`,
    '', 'Originalets PDF-textlager har felaktiga ligaturer (t.ex. “efect”, “frst”). Råtexten bevaras; sammanfattningarna och översättningarna använder normal stavning.', ''];
  for (const entry of database.entries) {
    lines.push(`## ${entry.id}: ${entry.heading}`, '', `Sida ${entry.sourcePages.join(', ')} · ${entry.category} · ${entry.review.status}`, '',
      ...(entry.headingSv ? ['Svensk rubrik: ' + entry.headingSv, ''] : []),
      '### Originaltext', '', entry.sourceText, '', '### Svarspunkter', '',
      ...entry.bullets.map(bullet => `- ${bullet.language} (${bullet.kind}, ${bullet.review.status}): ${bullet.text}`), '',
      '### Kortkopplingar', '', ...entry.cardLinks.map(link => `- ${link.cardId} · ${link.relation} · ${link.review.status}`), '',
      `Hänvisningar: ${entry.relatedEntryIds.join(', ') || 'Inga identifierade'}`, '', '- [ ] Användarens innehållsgranskning', '');
  }
  writeFileSync(new URL('../data/faq/review.md', import.meta.url), lines.join('\n'));
}
