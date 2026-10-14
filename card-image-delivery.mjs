import { readFileSync } from 'node:fs';
import { cardAssets } from './card-assets.mjs';
import { tabonyImage } from './card-images.mjs';

// Upload bytes with the first reply, so Discord need not fetch a third-party image.
// FAQ edits retain that exact attachment, including after a bot restart.
export function createCardImageDelivery({ cards, fetchImage = fetch, localAssets = cardAssets,
  maxBytes = 4 * 1024 * 1024, cacheBytes = 32 * 1024 * 1024, maxPending = 8, timeoutMs = 5000 } = {}) {
  const byId = new Map(cards.map(card => [card.id, card]));
  const cache = new Map(), pending = new Map();
  let used = 0;
  async function download(url) {
    const response = await fetchImage(url, {redirect:'error', signal:AbortSignal.timeout(timeoutMs)});
    if (!response.ok || !/^image\/jpeg(?:;|$)/.test(response.headers.get('content-type') ?? '') ||
        Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error('Unavailable card image.');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Card image exceeds size limit.');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (!(body[0] === 255 && body[1] === 216 && body[2] === 255)) throw new Error('Not a JPEG card image.');
    while (used + body.length > cacheBytes && cache.size) {
      const oldest = cache.keys().next().value;
      used -= cache.get(oldest).length;
      cache.delete(oldest);
    }
    if (body.length <= cacheBytes) { cache.set(url,body); used += body.length; }
    return body;
  }
  async function bytes(card) {
    if (card.imageAsset) return localAssets().get(card.imageAsset)?.body;
    const url = card.imageUrl;
    if (!tabonyImage(url) || card.imageCheck?.status !== 200 || card.imageCheck.url !== url) return null;
    if (cache.has(url)) {
      const body = cache.get(url); cache.delete(url); cache.set(url,body); return body;
    }
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= maxPending) return null;
    const loading = download(url).catch(() => null).finally(() => pending.delete(url));
    pending.set(url, loading);
    return loading;
  }
  return async function prepare(reply, {attachments = []} = {}) {
    const card = byId.get(reply?.cardId);
    if (!reply?.ok || !card) return reply?.messages?.[0];
    const original = reply.messages[0];
    const filename = card.imageAsset ?? 'card-' + card.id + '.jpg';
    const retained = attachments.find(file => (file.name ?? file.filename) === filename && file.id);
    const body = retained ? null : await bytes(card);
    if (!retained && !body) return original; // A source outage leaves the existing source link usable.
    const message = {...original, embeds:original.embeds.map(embed => ({...embed}))};
    message.embeds[0].image = {url:'attachment://' + filename};
    if (retained) message.attachments = [{id:retained.id, filename}];
    else { message.attachments = []; message.files = [{attachment:body, name:filename}]; }
    return message;
  };
}

export const prepareCardImage = createCardImageDelivery({
  cards:JSON.parse(readFileSync(new URL('./data/cards/catalog.json', import.meta.url), 'utf8')).cards,
});
