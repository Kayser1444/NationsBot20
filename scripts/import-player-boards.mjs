// Use the supplied boards with printed starting resource amounts, without redrawing.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const read = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const catalog = await read('data/cards/catalog.json');
const manifest = await read('data/cards/asset-manifest.json');
manifest.provenance = 'Printed starting cards from Tabony boards and supplied resource player boards; original pixels preserved.';
const nations = catalog.cards.filter(card => card.type === 'nation');
const baseNations = new Set(['China','Egypt','Greece','Persia','Rome']);
manifest.files = manifest.files.filter(file => !nations.some(card => card.id === file.cardId));
for (const card of nations) {
  const sourceFile = 'Reference/Nations_assets/PlayerBoard_start_' + card.name + '.jpg';
  const bytes = await readFile(new URL(sourceFile, root));
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Not a JPEG: ' + sourceFile);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = card.id + '.' + sha256.slice(0, 12) + '.jpg';
  await writeFile(new URL('public/card-assets/' + filename, root), bytes);
  manifest.files.push({cardId:card.id,filename,sha256,bytes:bytes.length,sourceFile,sourceSha256:sha256,
    provenance:'Supplied local player board with printed starting resource amounts; copied byte-for-byte.'});
  card.imageUrl = null;
  card.imageAsset = filename;
  card.imageCheck = null;
  card.boardStartingResources = true;
  card.boardSide = baseNations.has(card.name) ? 'B' : 'D';
}
await writeFile(new URL('data/cards/catalog.json',root),JSON.stringify(catalog,null,2)+'\n');
await writeFile(new URL('data/cards/asset-manifest.json',root),JSON.stringify(manifest,null,2)+'\n');
console.log('Imported ' + nations.length + ' player boards with starting resources.');
