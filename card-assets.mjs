import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cardAssetName } from './card-images.mjs';

let assets;
export function cardAssets() {
  if (assets) return assets;
  const files = JSON.parse(readFileSync(new URL('./data/cards/asset-manifest.json', import.meta.url), 'utf8')).files;
  const loaded = new Map();
  for (const file of files) {
    if (!cardAssetName(file.filename) || loaded.has(file.filename)) throw new Error('Invalid card asset filename.');
    const body = readFileSync(new URL('./public/card-assets/' + file.filename, import.meta.url));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const extension = file.filename.endsWith('.jpg') ? '.jpg' : '.png';
    if (sha256 !== file.sha256 || body.length !== file.bytes || !file.filename.endsWith('.' + sha256.slice(0, 12) + extension)) {
      throw new Error('Card asset changed: ' + file.cardId);
    }
    loaded.set(file.filename, { body, etag: '"' + sha256 + '"', contentType: extension === '.jpg' ? 'image/jpeg' : 'image/png' });
  }
  assets = loaded;
  return assets;
}
