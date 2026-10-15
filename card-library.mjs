import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const checksum = value => createHash('sha256').update(value).digest('hex');
const fold = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'");
const stop = new Set('a an and are as at be by can card cards does event events for from has have i in is it me of on or please that the their them there these this to was what when which who will with would'.split(' '));
const aliases = { lowest: 'least', lower: 'least', highest: 'most', money: 'gold', coin: 'gold', coins: 'gold',
  give: 'gain', gives: 'gain', add: 'gain', adds: 'gain', recruit: 'gain', receive: 'gain', take: 'gain', takes: 'gain',
  return: 'lose', returns: 'lose',
  military: 'military', strength: 'military', stable: 'stability', books: 'book', workers: 'worker', advisors: 'advisor',
  architects: 'architect', wonders: 'wonder', points: 'vp', point: 'vp', keep: 'keep', keeps: 'keep', retain: 'keep', retaining: 'keep',
  except: 'only', losses: 'lose', loses: 'lose', lost: 'lose', discard: 'lose',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
export const cardSearchTokens = value => [...new Set((fold(value).replace(/-\s*(\d+)/g, ' lose $1 ').replace(/\+\s*(\d+)/g, ' gain $1 ').match(/[a-z0-9]+/g) ?? [])
  .filter(word => !stop.has(word)).map(word => aliases[word] ?? word))];

// Deterministic editorial wording for retrieval, never a replacement for the source.
// Expand within each individual effect, preserving conditions, choices and amounts.
function expandedCardText(text) {
  if (!text) return '';
  const resource = label => label === 'VP' ? 'victory points (VP)' : label;
  return text
    .replace(/\b(Most|Least)\s+\[([^\]]+)\]/g, (_, comparison, label) =>
      `the nation with the ${comparison === 'Most' ? 'highest / most' : 'lowest / least'} ${resource(label)}`)
    .replace(/\bGo first\b/gi, 'move to first place in turn order; become the first player in player order')
    .replace(/\bGo last\b/gi, 'move to last place in turn order; become the last player in player order')
    .replace(/\bFirst to Pass\b/gi, 'the first player to pass (stop taking actions)')
    .replace(/\bLast to Pass\b/gi, 'the last player to pass (stop taking actions)')
    .replace(/\bPassing order\b/gi, 'passing order (the order in which players pass and stop taking actions)')
    .replace(/\bPlayer order\b/gi, 'player order (turn order)')
    .replace(/\+(\d+)\s*\[([^\]]+)\]/g, (_, amount, label) => `gain ${amount} ${resource(label)}`)
    .replace(/-(\d+)\s*\[([^\]]+)\]/g, (_, amount, label) => `lose ${amount} ${resource(label)}`)
    .replace(/\[VP\]/g, 'victory points (VP)');
}

// Keep the action tied to its resource: gaining Stone for undeploying a Worker
// must not rank as highly as actually taking a new Worker.
const effectRelations = value => new Set([...fold(value).replace(/-\s*(\d+)/g, ' lose $1 ').replace(/\+\s*(\d+)/g, ' gain $1 ')
  .matchAll(/\b(gain|take|receive|recruit|add|lose|return|discard)\s+(?:up to\s+)?(?:\d+\s*)?\[?(workers?|gold|food|stone|books?|architects?|vp|stability|military)\b/g)]
  .map(([, action, resource]) => `${aliases[action] ?? action}:${aliases[resource] ?? resource}`));
const orderEffects = value => new Set([
  ...(/\bgo first\b|first place in turn order|first player in player order|first to pass is player 1/i.test(value) ? ['first'] : []),
  ...(/\bgo last\b|last place in turn order|last player in player order/i.test(value) ? ['last'] : []),
]);

export function loadQuestionCards() {
  const root = new URL('./data/cards/library/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  const text = readFileSync(new URL('entries.json', root), 'utf8').replace(/\r\n/g, '\n');
  if (manifest.schemaVersion !== 1 || checksum(text) !== manifest.entriesSha256) throw new Error('Card library checksum mismatch.');
  const library = JSON.parse(text);
  if (library.schemaVersion !== 1 || library.language !== 'en' || library.cards.length !== manifest.cards) throw new Error('Invalid card library.');
  return createCardLibrary(library);
}

export function createCardLibrary(library) {
  const documents = [], seen = new Set();
  for (const card of library.cards) {
    if (typeof card.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(card.id) || seen.has(card.id) || !card.name) throw new Error('Invalid card identity.');
    seen.add(card.id);
    const printed = card.printed;
    if (printed && (printed.cardId !== card.id || printed.review?.status !== 'image-verified' ||
        !/^[a-f0-9]{64}$/.test(printed.sourceImage?.sha256) || !printed.effects?.length)) throw new Error('Invalid card image review.');
    const implementation = card.implementation;
    const entries = printed?.effects ?? (implementation?.effects?.length ? implementation.effects : [{ slot: null, name: card.name, text: implementation?.description ?? '' }]);
    const slots = new Set();
    for (const entry of entries) {
      if (entry.slot !== null && !['a', 'b'].includes(entry.slot) || slots.has(entry.slot)) throw new Error('Invalid card effect slot.');
      slots.add(entry.slot);
      const id = `cards/${card.id}${entry.slot ? '/' + entry.slot : ''}`;
      const evidenceKind = printed ? 'printed-card' : implementation ? 'implementation-description' : 'metadata-only';
      const status = printed ? 'image-verified' : 'image-transcription-pending';
      const expanded = expandedCardText(entry.text);
      const searchPhrases = [...(entry.searchPhrases ?? []), ...(expanded && expanded !== entry.text ? [`Expanded search wording: ${expanded}`] : [])];
      const lines = [`# ${entry.name}`, `Card ID: ${card.id}`, `Whole card: ${card.name}`, `Type: ${card.type}; Age: ${card.age ?? 'not specified'}`,
        `Evidence: ${evidenceKind}; review: ${status}`, ''];
      if (printed) {
        lines.push('## Printed gameplay text (icons normalized to English labels)', entry.text,
          `Architects: ${printed.architects}; Famine: ${printed.famine}`,
          `Image SHA-256: ${printed.sourceImage.sha256}`, `Image source: ${printed.sourceImage.file}`,
          `Review: ${printed.review.reviewer}, ${printed.review.reviewedAt}. Historical dates, artwork and set symbols are outside this transcription.`, '');
      } else if (implementation) {
        lines.push('## Tabony implementation description - NOT verified printed card text',
          `Implementation description commit: ${implementation.commit}. Check the current code snapshot before making implementation claims.`, entry.text || 'No special-effect description available.');
        for (const fact of implementation.facts) lines.push(`${fact.label}: ${fact.value}`);
        lines.push('Description and numerical fields may not cover all behavior; follow the referenced class and its handlers.');
      } else lines.push('Metadata only. No effect text is available. Do not infer an ability from the card name.');
      if (searchPhrases.length) lines.push('## Search paraphrases (editorial, not printed rules)', ...searchPhrases, '');
      if (implementation) lines.push('## Implementation source references', ...implementation.sources.map(ref => `code/${ref.file}:${ref.line} (commit ${implementation.commit})`));
      documents.push({ id, title: entry.name, kind: 'card', cardId: card.id, cardName: card.name, type: card.type, age: card.age,
        evidenceKind, review: status, ...(printed ? { imageSha256: printed.sourceImage.sha256 } : {}),
        ...(implementation ? { implementationCommit: implementation.commit } : {}), text: lines.join('\n'),
        searchText: [entry.text, ...searchPhrases, ...(printed ? [] : (implementation?.facts ?? []).map(fact => `${fact.label}: ${fact.value}`))].join(' '),
        searchNames: [entry.name, card.name, ...(card.aliases ?? [])].join(' ') });
    }
  }
  const index = documents.map(doc => ({ doc, body: new Set(cardSearchTokens(doc.searchText)), names: new Set(cardSearchTokens(doc.title)),
    aliases: new Set(cardSearchTokens(doc.searchNames)), relations: effectRelations(doc.searchText), order: orderEffects(doc.searchText) }));
  const frequencies = new Map();
  for (const item of index) for (const word of new Set([...item.body, ...item.names, ...item.aliases])) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  const types = new Set(documents.map(doc => doc.type));
  const search = ({ query, card_type = 'all' }) => {
    if (typeof query !== 'string' || query.length > 240 || !query.trim()) return { error: 'Use a short English card name or effect description.' };
    if (card_type !== 'all' && !types.has(card_type)) return { error: 'Unknown card type.' };
    const type = card_type === 'all' && /\bevents?\b/i.test(query) ? 'event' : card_type;
    const terms = cardSearchTokens(query);
    if (!terms.length) return [];
    return index.filter(item => type === 'all' || item.doc.type === type).map(item => {
      let score = 0; const matched = [];
      for (const term of terms) {
        const weight = 1 + Math.log(1 + index.length / (1 + (frequencies.get(term) ?? 0)));
        if (item.names.has(term) || item.body.has(term) || item.aliases.has(term)) {
          matched.push(term); score += weight * (item.names.has(term) ? 4 : item.body.has(term) ? 2 : 1);
        } else if (/^\d+$/.test(term)) score -= weight * 2;
      }
      const coverage = matched.length / terms.length;
      if (coverage < 0.4) score = 0;
      else {
        for (const relation of item.relations) if (relation.split(':').every(term => terms.includes(term))) score += 15;
        if (terms.some(term => ['order', 'player', 'turn'].includes(term)))
          for (const position of item.order) if (terms.includes(position)) score += 20;
        score *= coverage * coverage;
      }
      return { item, score, matched };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.item.doc.id.localeCompare(b.item.doc.id))
      .slice(0, 8).map(({ item: { doc }, score, matched }) => ({ id: doc.id, name: doc.title, cardId: doc.cardId,
        cardName: doc.cardName, type: doc.type, age: doc.age, evidenceKind: doc.evidenceKind, review: doc.review,
        score: Math.round(score * 100) / 100, matched, excerpt: doc.searchText.slice(0, 650) }));
  };
  return { documents, search, summary: { cards: library.cards.length, searchableEntries: documents.length,
    imageVerifiedCards: library.cards.filter(card => card.printed).length, implementationCommit: library.implementationCommit } };
}
