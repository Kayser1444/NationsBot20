// Explicit maintenance command; Discord requests never fetch or scan the asset server.
import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../data/cards/catalog.json', import.meta.url);
const catalog = JSON.parse(await readFile(path, 'utf8'));
const cards = catalog.cards.filter(card => card.imageUrl && (process.argv.includes('--all') || card.imageCheck?.url !== card.imageUrl));
const checkedAt = new Date().toISOString();
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < cards.length) {
    const card = cards[cursor++];
    if (!/^https:\/\/games\.tabony\.net\/static\/public\/Nations\/(?:cards\/[A-Za-z0-9_-]+|nations\/[A-Za-z]+)\.jpg$/.test(card.imageUrl)) throw new Error('Unexpected image URL: ' + card.id);
    const response = await fetch(card.imageUrl, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(20000) });
    const contentType = response.headers.get('content-type');
    if (response.status !== 404 && !(response.ok && contentType?.startsWith('image/jpeg'))) throw new Error(`Image check failed: ${card.id}: ${response.status} ${contentType}`);
    card.imageCheck = { url: card.imageUrl, checkedAt, status: response.status, contentType };
    card.enabled = true;
  }
}));
await writeFile(path, JSON.stringify(catalog, null, 2) + '\n');
console.log(JSON.stringify({ checked: cards.length, verified: cards.filter(card => card.imageCheck.status === 200).length,
  missing: cards.filter(card => card.imageCheck.status !== 200).map(card => ({ id: card.id, name: card.name })) }, null, 2));
