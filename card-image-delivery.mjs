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
  return async function prepare(reply, {attachments = [], embeds = [], imageUrl = null, allowUpload = true} = {}) {
    if (!reply?.ok || !byId.has(reply.cardId)) return reply?.messages?.[0];
    const original = reply.messages[0];
    const targets = reply.imageTargets ?? [{cardId:reply.cardId,embedIndex:0}];
    const images = await Promise.all(targets.map(async target => {
      const card = byId.get(target.cardId);
      if (!card) return null;
      const filename = card.imageAsset ?? 'card-' + card.id + '.jpg';
      let retained = attachments.find(file => (file.name ?? file.filename) === filename && file.id);
      // Discord can hide embedded uploads from `attachments`. Recover the ID,
      // keeping attachment:// so an edit cannot expose a standalone duplicate.
      try {
        const url = new URL(embeds[target.embedIndex]?.image?.url ?? (target.embedIndex === 0 ? imageUrl : null));
        if (['https://cdn.discordapp.com','https://media.discordapp.net'].includes(url.origin) && !url.username && !url.password &&
            /^\/attachments\/\d+\/\d+\//.test(url.pathname) && url.pathname.split('/').length === 5 && url.pathname.split('/').at(-1) === filename) {
          retained ??= {id:url.pathname.split('/')[3]};
        }
      } catch { /* An absent or unrelated image requires a fresh verified upload. */ }
      if (retained) return {...target,filename,id:retained.id};
      if (!allowUpload) return null;
      const body = await bytes(card);
      return body ? {...target,filename,body} : null;
    }));
    if (!images.some(Boolean)) return original; // Source links remain usable during an outage.
    const message = {...original,embeds:original.embeds.map(embed => ({...embed})),attachments:[]};
    for (const image of images.filter(Boolean)) {
      message.embeds[image.embedIndex].image = {url:'attachment://' + image.filename};
      if (image.id) message.attachments.push({id:image.id,filename:image.filename});
      else (message.files ??= []).push({attachment:image.body,name:image.filename});
    }
    return message;
  };
}

export const prepareCardImage = createCardImageDelivery({
  cards:JSON.parse(readFileSync(new URL('./data/cards/catalog.json', import.meta.url), 'utf8')).cards,
});
