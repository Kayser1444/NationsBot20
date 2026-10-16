import { readFileSync } from 'node:fs';
import { text, translations } from './language.mjs';
import { cardAssetOrigin, cardAssetName, cardImageUrl, tabonyImage } from './card-images.mjs';
import { validateRulesDifferences } from './question-errata.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
const escape = value => String(value).replace(/[\\`*_\[\]<>~|]/g, '\\$&');
// Review decisions are independent of publication; rejected or unknown states stay hidden.
const visible = value => ['approved', 'pending'].includes(value?.review?.status);
const typeRules = { advisor: ['advisor-advisor'], battle: ['battle-battle'], golden_age: ['golden-age-bonus'],
  wonder: ['wonder-wonder'], natural_wonder: ['natural-wonders-natural-wonders'], event: ['event-event'] };
const silent = { parse: [], users: [], roles: [] };
const embedLength = embed => [embed.title, embed.description, embed.footer?.text, embed.author?.name,
  ...(embed.fields ?? []).flatMap(field => [field.name, field.value])].reduce((sum, value) => sum + (value?.length ?? 0), 0);

export function createCardBank({ catalog, sources, entries, assetOrigin = null, rulesDifferences = () => read('./data/question/tabony-rules-differences.json'), library = read('./data/cards/library/entries.json') }) {
  if (assetOrigin) assetOrigin = cardAssetOrigin({ NATIONS_CARD_ASSET_ORIGIN: assetOrigin });
  const cards = catalog.cards.filter(card => card.enabled);
  const names = cards.map(card => ({id:card.id, name:normalize(card.name)})).filter(card => card.name.length > 3);
  let indexedNotes, indexedHash;
  function indexNotes(snapshot) {
    if (indexedHash === snapshot.sha256) return indexedNotes;
    indexedNotes = snapshot.sections.flatMap(section => section.entries.map(note => {
      const normalized = ' ' + normalize(note) + ' ';
      const named = names.filter(card => normalized.includes(' ' + card.name + ' '));
      // Pagoda is not China's starting card when the post says Shwedagon Pagoda.
      const cardIds = named.filter(card => !named.some(other => other.name.length > card.name.length &&
        (' ' + other.name + ' ').includes(' ' + card.name + ' '))).map(card => card.id);
      return {section,note,cardIds};
    }));
    indexedHash = snapshot.sha256;
    return indexedNotes;
  }
  const sourceById = new Map(sources.sources.map(source => [source.id, source]));
  const allCards = new Set(catalog.cards.map(card => card.id));
  const entryIds = new Set(entries.entries.map(entry => entry.id));
  if (allCards.size !== catalog.cards.length || entryIds.size !== entries.entries.length) throw new Error('Duplicate card or FAQ IDs.');
  for (const entry of entries.entries) {
    if (!sourceById.has(entry.sourceId) || entry.cardLinks.some(link => !allCards.has(link.cardId)) ||
        entry.relatedEntryIds.some(id => !entryIds.has(id))) throw new Error('Invalid FAQ reference: ' + entry.id);
  }
  for (const card of cards) {
    if (card.imageUrl !== null && !tabonyImage(card.imageUrl)) throw new Error('Invalid card image: ' + card.id);
    if (card.imageAsset && (!cardAssetName(card.imageAsset) || !card.imageAsset.startsWith(card.id + '.'))) throw new Error('Invalid local card image: ' + card.id);
  }
  function resolve(query) {
    const selected = normalize(query);
    const byId = cards.find(card => card.id === query);
    if (byId) return byId;
    const found = cards.filter(card => [card.name, ...card.aliases].some(name => normalize(name) === selected));
    const progress = found.filter(card => !card.variant);
    if (progress.length === 1) return progress[0];
    return found.length === 1 ? found[0] : null;
  }
  function autocomplete(query, language = 'en-US', { nations = false } = {}) {
    const selected = normalize(query);
    const rank = card => Math.min(...[card.name, ...card.aliases].map(name => {
      const value = normalize(name);
      return value === selected ? 0 : value.startsWith(selected) ? 1 : value.includes(selected) ? 2 : 3;
    }));
    return cards.filter(card => (card.type === 'nation') === nations && rank(card) < 3)
      .sort((a, b) => rank(a) - rank(b) || Number(Boolean(a.variant)) - Number(Boolean(b.variant)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, 25)
      .map(card => ({ name: `${card.name}${card.variant ? ' (' + card.variant + ')' : ''} · ${text(language, 'cardType_' + card.type)}${card.nation ? ' · ' + card.nation : ''}${card.age ? ' · ' + ['I', 'II', 'III', 'IIII'][card.age - 1] : card.age === 0 ? ' · ' + text(language, 'cardStarting') : ''}`.slice(0, 100), value: card.id }));
  }
  function render(query, language = 'en-US', { faqPage = 0 } = {}) {
    if (!Object.hasOwn(translations, language)) language = 'en-US';
    const card = resolve(query);
    if (!card) return { ok: false, messages: [{ content: text(language, 'cardUnavailable'), allowed_mentions: silent }] };
    const applicable = entry => visible(entry) && !(card.type === 'nation' && entry.category === 'dynasty');
    const matched = entries.entries.filter(entry => applicable(entry) && (
      entry.cardLinks.some(link => link.cardId === card.id && visible(link)) ||
      (typeRules[card.type] ?? []).includes(entry.id) && !entry.cardLinks.some(link => link.cardId === card.id && link.review?.status === 'rejected')));
    // Follow explicit rule references, once each, without copying text between entries.
    const selectedIds = new Set(matched.map(entry => entry.id));
    for (let i = 0; i < matched.length; i++) for (const id of matched[i].relatedEntryIds) {
      const related = entries.entries.find(entry => entry.id === id);
      if (related && applicable(related) && !selectedIds.has(id) &&
          !related.cardLinks.some(link => link.cardId === card.id && link.review?.status === 'rejected')) {
        selectedIds.add(id);
        matched.push(related);
      }
    }
    matched.sort((a, b) => Number(!a.cardLinks.some(link => link.cardId === card.id && link.relation === 'own_entry' && visible(link))) -
      Number(!b.cardLinks.some(link => link.cardId === card.id && link.relation === 'own_entry' && visible(link))) || a.sourcePages[0] - b.sourcePages[0]);
    const points = matched.flatMap(entry => entry.bullets.filter(bullet => visible(bullet) && bullet.language === language)
      .map(bullet => ({ entry, bullet })));
    const source = matched.length ? sourceById.get(matched[0].sourceId) : sources.sources[0];
    const metadata = `**${text(language, 'cardType_' + card.type)}${card.nation ? ' · ' + card.nation : ''}${card.age ? ' · ' + text(language, 'cardAge') + ' ' + ['I', 'II', 'III', 'IIII'][card.age - 1] : card.age === 0 ? ' · ' + text(language, 'cardStarting') : ''}${card.variant ? ' · ' + card.variant : ''}${card.boardSide ? ' · ' + text(language, 'cardBoardSide', { side: card.boardSide }) : ''}**`;
    const description = language === 'sv-SE' ? card.descriptionSv : card.descriptionEn;
    const imageUrl = cardImageUrl(card, assetOrigin);
    const message = { content: text(language, card.type === 'nation' ? 'nationHeading' : 'cardHeading'), allowed_mentions: silent, embeds: [
      { title: card.name, color: 12092983, ...(imageUrl ? { url: imageUrl, image: { url: imageUrl } } : {}) },
      { description: metadata + (description ? '\n' + description : '') + (card.promo ? '\n' + text(language, 'cardPromoNote') : ''), color: 12092983 },
    ] };
    const imageTargets = [{cardId:card.id,embedIndex:0}];
    const relatedCards = [card, ...(card.type === 'nation' ? cards.filter(candidate =>
      (candidate.nation === card.name || candidate.boardSource?.nation === card.name) && (candidate.type === 'dynasty' || candidate.age === 0)) : [])];
    if (card.type === 'nation') {
      for (const dynasty of cards.filter(candidate => candidate.type === 'dynasty' && candidate.nation === card.name)) {
        const url = cardImageUrl(dynasty, assetOrigin);
        imageTargets.push({cardId:dynasty.id,embedIndex:message.embeds.length});
        message.embeds.push({title:dynasty.name,description:text(language,'cardType_dynasty') + ' · ' + card.name,
          color:12092983,...(url ? {url,image:{url}} : {})});
      }
    }
    if (!imageUrl && !card.imageAsset) message.embeds[1].description += '\n' + text(language, 'cardImagePending');
    // Exact named references are supplemented only by explicit implementation facts.
    // Keep the owner's English wording, attribution and historical comparison intact.
    const differences = validateRulesDifferences(rulesDifferences());
    const privateArchitects = relatedCards.some(candidate => {
      const implementation = library.cards.find(item => item.id === candidate.id)?.implementation;
      return implementation?.facts.some(fact => fact.field === 'private_architects' && Number(fact.value) > 0) ||
        /private \[Architects?\]/i.test(implementation?.description ?? '');
    });
    const notes = indexNotes(differences).filter(({note,cardIds}) =>
      relatedCards.some(candidate => cardIds.includes(candidate.id)) ||
      privateArchitects && note.startsWith('Private architects are tied to') ||
      card.name === 'Turmoil' && note.startsWith('Discarding turmoil'));
    const header = text(language, 'cardFaqHeading', { version: source.version, count: points.length });
    const footer = '\n\n' + (language !== 'en-US' ? `• ${text(language, 'cardMachineTranslated')}. ` : '') +
      `${text(language, 'cardSource')}: [FAQ++ ${source.version}](<${source.officialUrl}>)`;
    // Reserve room for the complete header, source and page label in every page.
    const pageLabelReserve = text(language, 'cardFaqPage', { current: 99999, total: 99999 }).length;
    const capacity = Math.min(3000, Math.min(4096, 6000 - message.embeds.reduce((sum, embed) => sum + embedLength(embed), 0)) -
      header.length - footer.length - pageLabelReserve - 4);
    if (capacity < 100) throw new Error('Card metadata leaves no space for FAQ pages.');
    const lines = [];
    const paragraphs = notes.map(({ section, note }) => ({ label: `- **[Tabony · Logitude](<${differences.url}>) · ${escape(section.title)} (English original):** `, body: note }));
    for (const { entry, bullet } of points) {
      const heading = language === 'sv-SE' ? entry.headingSv ?? entry.heading : entry.headingTranslations?.[language] ?? entry.heading;
      const label = `- **${escape(heading)} · ${text(language, 'cardPage')} ${entry.sourcePages.join(', ')}:** `;
      paragraphs.push({label, body: bullet.text});
    }
    for (const { label, body } of paragraphs) {
      let remaining = escape(body.replace(/\s+/g, ' ').trim());
      const pointCapacity = capacity - label.length;
      if (pointCapacity < 100) throw new Error('FAQ or rules-difference heading is too long.');
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
    if (!points.length) lines.push(text(language, 'cardFaqPending'));
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
      : [button(text(language, 'cardFaqShow', { count: points.length }), 0, !points.length && !notes.length)];
    if (expanded) {
      const pageLabel = pages.length > 1 ? '\n' + text(language, 'cardFaqPage', { current: faqPage + 1, total: pages.length }) : '';
      message.embeds.push({ description: header + pageLabel + '\n\n' + pages[faqPage] + footer, color: 12092983 });
      if (pages.length > 1) buttons.push(
        button(text(language, 'cardFaqPrevious'), Math.max(0, faqPage - 1), faqPage === 0),
        button(text(language, 'cardFaqNext'), Math.min(pages.length - 1, faqPage + 1), faqPage === pages.length - 1),
      );
    } else if (!points.length) {
      message.embeds[1].description += '\n' + text(language, 'cardFaqPending');
    }
    message.components = [{ type: 1, components: buttons }];
    return { ok: true, cardId: card.id, imageTargets, messages: [message], entryIds: matched.map(entry => entry.id),
      pointCount: points.length, faqPageCount: pages.length, faqPage };
  }
  function renderButton(customId) {
    const match = /^cardfaq:1:([A-Za-z0-9_-]+):(sv-SE|en-US|de|fr|es-ES|zh-CN):(closed|0|[1-9]\d{0,3})$/.exec(String(customId));
    if (!match || customId.length > 100) return null;
    return render(match[1], match[2], { faqPage: match[3] === 'closed' ? null : Number(match[3]) });
  }
  function renderNation(query, language = 'en-US', options) {
    if (resolve(query)?.type !== 'nation') return {ok:false,messages:[{content:text(language,'nationUnavailable'),allowed_mentions:silent}]};
    return render(query,language,options);
  }
  return { resolve, autocomplete, render, renderButton, renderNation,
    autocompleteNations:(query,language) => autocomplete(query,language,{nations:true}) };
}

export const loadCardBank = (options = {}) => createCardBank({ catalog: read('./data/cards/catalog.json'), sources: read('./data/faq/sources.json'), entries: read('./data/faq/entries.json'), assetOrigin: cardAssetOrigin(), ...options });
export const cardBank = loadCardBank();
