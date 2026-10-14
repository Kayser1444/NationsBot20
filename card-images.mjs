export const tabonyImage = url => /^https:\/\/games\.tabony\.net\/static\/public\/Nations\/(?:cards\/[A-Za-z0-9_-]+|nations\/[A-Za-z]+)\.jpg$/.test(url);
export const cardAssetName = name => /^[A-Za-z0-9_-]+\.[a-f0-9]{12}\.(?:png|jpg)$/.test(name);

export function cardAssetOrigin(env = process.env) {
  const value = env.NATIONS_CARD_ASSET_ORIGIN;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || value.replace(/\/$/, '') !== url.origin) {
    throw new Error('Card asset origin must be an HTTPS origin.');
  }
  return url.origin;
}

export function cardImageUrl(card, assetOrigin) {
  if (card.imageAsset && assetOrigin) return assetOrigin + '/card-assets/' + card.imageAsset;
  if (card.imageUrl && card.imageCheck?.status === 200 && card.imageCheck.url === card.imageUrl) return card.imageUrl;
  return null;
}
