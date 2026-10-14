// Deterministic extraction of the printed cards, using Tabony's own slot rectangles.
// sharp is a build-time tool only; pass its installed module path as --sharp=<path>.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const sharpPath = process.argv.find(value => value.startsWith('--sharp='))?.slice(8) ?? 'sharp';
const gameSource = process.argv.find(value => value.startsWith('--game-source='))?.slice(14);
if (!gameSource) throw new Error('Pass --game-source=<path to TabonyGames>.');
const sharp = createRequire(import.meta.url)(sharpPath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = new URL('../', import.meta.url);
const catalogPath = new URL('data/cards/catalog.json', root);
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const template = await readFile(resolve(gameSource, 'Nations/templates/Nations/match.html'), 'utf8');
const literal = /const nation_boxes = (\{[\s\S]*?\n        \});/.exec(template)?.[1];
if (!literal) throw new Error('Cannot find Tabony nation slot rectangles.');
const width = Number(/const card_width = (\d+);/.exec(template)?.[1]);
const height = Number(/const card_height = (\d+);/.exec(template)?.[1]);
const slots = JSON.parse(literal.replaceAll("'", '"').replaceAll('card_width', String(width)).replaceAll('card_height', String(height)));
await mkdir(new URL('Reference/tabony-boards/', root), { recursive: true });
await mkdir(new URL('public/card-assets/', root), { recursive: true });
const boards = new Map();
const checkedAt = new Date().toISOString();
// Keep the separately imported player boards when refreshing starting-card crops.
const files = JSON.parse(await readFile(new URL('data/cards/asset-manifest.json', root), 'utf8')).files
  .filter(file => !catalog.cards.some(card => card.id === file.cardId && card.variant));
for (const card of catalog.cards.filter(card => card.variant)) {
  const { nation, slot, url } = card.boardSource;
  if (!/^https:\/\/games\.tabony\.net\/static\/public\/Nations\/nations\/[A-Za-z]+\.jpg$/.test(url)) throw new Error('Invalid board source.');
  if (!boards.has(nation)) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw new Error('Cannot download board: ' + nation);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(new URL('Reference/tabony-boards/' + nation + '.jpg', root), bytes);
    boards.set(nation, bytes);
    const record = catalog.cards.find(item => item.id === 'nation-' + nation);
    record.enabled = true;
    if (!record.imageAsset) record.imageCheck = { url, checkedAt, status: 200, contentType: 'image/jpeg' };
  }
  const source = boards.get(nation);
  const [left, top, cropWidth, cropHeight] = slots[nation]?.[slot] ?? [];
  if (![left, top, cropWidth, cropHeight].every(Number.isInteger)) throw new Error('Unknown slot: ' + card.id);
  const crop = { left, top, width: cropWidth, height: cropHeight };
  const bytes = await sharp(source).extract(crop).png().toBuffer();
  const sha256 = hash(bytes);
  const filename = card.id + '.' + sha256.slice(0, 12) + '.png';
  await writeFile(new URL('public/card-assets/' + filename, root), bytes);
  files.push({ cardId: card.id, filename, sha256, bytes: bytes.length, width: cropWidth, height: cropHeight,
    sourceUrl: url, sourceSha256: hash(source), crop });
  card.imageUrl = null;
  card.imageAsset = filename;
  card.enabled = true;
}
await writeFile(new URL('data/cards/asset-manifest.json', root), JSON.stringify({ schemaVersion: 1,
  provenance: 'Printed starting cards from Tabony boards and supplied resource player boards; original pixels preserved.',
  templateSha256: hash(template), files }, null, 2) + '\n');
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(JSON.stringify({ boards: boards.size, extractedCards: catalog.cards.filter(card => card.variant).length,
  totalAssets:files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
