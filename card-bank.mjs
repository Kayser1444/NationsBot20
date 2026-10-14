import { readFileSync } from 'node:fs';
import { text } from './language.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
const escape = value => String(value).replace(/[\\`*_\[\]<>~|]/g, '\\$&');
const approved = value => value?.review?.status === 'approved';
const silent = { parse: [], users: [], roles: [] };
const embedLength = embed => [embed.title, embed.description, embed.footer?.text, embed.author?.name,
  ...(embed.fields ?? []).flatMap(field => [field.name, field.value])].reduce((sum, value) => sum + (value?.length ?? 0), 0);

export function createCardBank({ catalog, sources, entries }) {
  const cards = catalog.cards.filter(card => card.enabled);
  const sourceById = new Map(sources.sources.map(source => [source.id, source]));
  const allCards = new Set(catalog.cards.map(card => card.id));
  const entryIds = new Set(entries.entries.map(entry => entry.id));
  if (allCards.size !== catalog.cards.length || entryIds.size !== entries.entries.length) throw new Error('Duplicate card or FAQ IDs.');
  for (const entry of entries.entries) {
    if (!sourceById.has(entry.sourceId) || entry.cardLinks.some(link => !allCards.has(link.cardId)) ||
        entry.relatedEntryIds.some(id => !entryIds.has(id))) throw new Error('Invalid FAQ reference: ' + entry.id);
  }
  for (const card of cards) {
    if (!/^https:\/\/games\.tabony\.net\/static\/public\/Nations\/cards\/[A-Za-z0-9_-]+\.jpg$/.test(card.imageUrl)) throw new Error('Invalid card image: ' + card.id);
  }
  function resolve(query) {
    const selected = normalize(query);
    const found = cards.filter(card => card.id === query || [card.name, ...card.aliases].some(name => normalize(name) === selected));
    return found.length === 1 ? found[0] : null;
  }
  function autocomplete(query, language = 'en-US') {
    const selected = normalize(query);
    return cards.filter(card => [card.name, ...card.aliases].some(name => normalize(name).includes(selected)))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 25)
      .map(card => ({ name: `${card.name} · ${text(language, 'cardType_' + card.type)}${card.age ? ' · ' + ['I', 'II', 'III', 'IIII'][card.age - 1] : ''}`.slice(0, 100), value: card.id }));
  }
  function render(query, language = 'en-US', { faqPage = null } = {}) {
    if (!['sv-SE', 'en-US'].includes(language)) language = 'en-US';
    const card = resolve(query);
    if (!card) return { ok: false, messages: [{ content: text(language, 'cardUnavailable'), allowed_mentions: silent }] };
    const matched = entries.entries.filter(entry => approved(entry) && entry.cardLinks.some(link => link.cardId === card.id && approved(link)));
    matched.sort((a, b) => Number(!a.cardLinks.some(link => link.cardId === card.id && link.relation === 'own_entry' && approved(link))) -
      Number(!b.cardLinks.some(link => link.cardId === card.id && link.relation === 'own_entry' && approved(link))) || a.sourcePages[0] - b.sourcePages[0]);
    const points = matched.flatMap(entry => entry.bullets.filter(bullet => approved(bullet) && bullet.language === language).map(bullet => ({ entry, bullet })));
    const source = matched.length ? sourceById.get(matched[0].sourceId) : sources.sources[0];
    const metadata = `**${text(language, 'cardType_' + card.type)}${card.age ? ' · ' + text(language, 'cardAge') + ' ' + ['I', 'II', 'III', 'IIII'][card.age - 1] : ''}**`;
    const description = language === 'sv-SE' ? card.descriptionSv : card.descriptionEn;
    const message = { content: text(language, 'cardPilot'), allowed_mentions: silent, embeds: [
      { title: card.name, url: card.imageUrl, color: 12092983, image: { url: card.imageUrl } },
      { description: metadata + (description ? '\n' + description : ''), color: 12092983 },
    ] };
    const header = text(language, 'cardFaqHeading', { version: source.version, count: points.length });
    const footer = '\n\n' + text(language, 'cardFaqScope') + '\n' +
      `${text(language, 'cardSource')}: [FAQ++ ${source.version}](<${source.officialUrl}>)`;
    // Reserve room for the complete header, source and page label in every page.
    const pageLabelReserve = text(language, 'cardFaqPage', { current: 99999, total: 99999 }).length;
    const capacity = Math.min(3000, Math.min(4096, 6000 - message.embeds.reduce((sum, embed) => sum + embedLength(embed), 0)) -
      header.length - footer.length - pageLabelReserve - 4);
    if (capacity < 100) throw new Error('Card metadata leaves no space for FAQ pages.');
    const lines = [];
    for (const { entry, bullet } of points) {
      const label = `- **${escape(entry.heading)} · ${text(language, 'cardPage')} ${entry.sourcePages.join(', ')}:** `;
      let remaining = escape(bullet.text.replace(/\s+/g, ' ').trim());
      const pointCapacity = capacity - label.length;
      if (pointCapacity < 100) throw new Error('FAQ heading is too long: ' + entry.id);
      // Keep each point together where possible; repeat its source on continuation.
      while (remaining) {
        let end = remaining.length <= pointCapacity ? remaining.length : remaining.lastIndexOf(' ', pointCapacity);
        if (end <= 0) end = pointCapacity;
        // Do not cut a Markdown escape or a Unicode surrogate pair in half.
        if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
        let backslashes = 0;
        for (let i = end - 1; i >= 0 && remaining[i] === '\\'; i--) backslashes++;
        if (backslashes % 2) end--;
        lines.push(label + remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
      }
    }
    if (!lines.length) lines.push(text(language, 'cardFaqPending'));
    const pages = [''];
    for (const line of lines) {
      if (pages.at(-1) && (pages.at(-1) + '\n' + line).length > capacity) pages.push('');
      pages[pages.length - 1] += (pages.at(-1) ? '\n' : '') + line;
    }
    const expanded = faqPage !== null;
    if (expanded && (!Number.isSafeInteger(faqPage) || faqPage < 0 || faqPage >= pages.length)) {
      return { ok: false, messages: [{ content: text(language, 'cardFaqExpired'), allowed_mentions: silent }] };
    }
    const button = (label, target, disabled = false) => ({ type: 2, style: 2, label,
      custom_id: `cardfaq:1:${card.id}:${language}:${target}`, disabled });
    const buttons = expanded ? [button(text(language, 'cardFaqHide'), 'closed')]
      : [button(text(language, 'cardFaqShow', { count: points.length }), 0, !points.length)];
    if (expanded) {
      const pageLabel = text(language, 'cardFaqPage', { current: faqPage + 1, total: pages.length });
      message.embeds.push({ description: header + '\n' + pageLabel + '\n\n' + pages[faqPage] + footer, color: 12092983 });
      if (pages.length > 1) buttons.push(
        button(text(language, 'cardFaqPrevious'), Math.max(0, faqPage - 1), faqPage === 0),
        button(text(language, 'cardFaqNext'), Math.min(pages.length - 1, faqPage + 1), faqPage === pages.length - 1),
      );
    } else if (!points.length) {
      message.embeds[1].description += '\n' + text(language, 'cardFaqPending');
    }
    message.components = [{ type: 1, components: buttons }];
    return { ok: true, cardId: card.id, messages: [message], entryIds: matched.map(entry => entry.id),
      pointCount: points.length, faqPageCount: pages.length, faqPage };
  }
  function renderButton(customId) {
    const match = /^cardfaq:1:([A-Za-z0-9_-]+):(sv-SE|en-US):(closed|0|[1-9]\d{0,3})$/.exec(String(customId));
    if (!match || customId.length > 100) return null;
    return render(match[1], match[2], { faqPage: match[3] === 'closed' ? null : Number(match[3]) });
  }
  return { resolve, autocomplete, render, renderButton };
}

export const cardBank = createCardBank({ catalog: read('./data/cards/catalog.json'), sources: read('./data/faq/sources.json'), entries: read('./data/faq/entries.json') });
