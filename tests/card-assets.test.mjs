import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startCardAssetServer } from '../card-asset-server.mjs';
import { cardAssetOrigin } from '../card-images.mjs';
import { createCardBank } from '../card-bank.mjs';
const read = path => JSON.parse(readFileSync(new URL('../data/' + path, import.meta.url), 'utf8'));
const manifest = read('cards/asset-manifest.json');
const catalog = read('cards/catalog.json');
const origin = 'https://cards.example.test';
const bank = () => createCardBank({ catalog, sources: read('faq/sources.json'), entries: read('faq/entries.json'), assetOrigin: origin });

test('all starting variants map to real extracted PNGs and keep the correct nation and board slot', () => {
  const cards = catalog.cards.filter(card => card.variant);
  assert.equal(cards.length, 74);
  const startingFiles = manifest.files.filter(file => cards.some(card => card.id === file.cardId));
  assert.equal(startingFiles.length, cards.length);
  assert.equal(new Set(startingFiles.map(file => file.cardId)).size, cards.length);
  const cardsById = new Map(cards.map(card => [card.id, card]));
  const renderer = bank();
  for (const file of startingFiles) {
    const card = cardsById.get(file.cardId);
    assert.equal(file.filename, card.imageAsset);
    assert.equal(file.sourceUrl, card.boardSource.url);
    assert.match(file.sourceUrl, new RegExp('/' + card.variant + '\\.jpg$'));
    const bytes = readFileSync(new URL('../public/card-assets/' + file.filename, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(bytes.length, file.bytes);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(bytes.readUInt32BE(16), 164);
    assert.equal(bytes.readUInt32BE(20), 254);
    const reply = renderer.render(card.id);
    assert.equal(reply.messages[0].embeds[0].image.url, origin + '/card-assets/' + file.filename);
  }
  assert.equal(cardsById.get('J_Epr').boardSource.slot, 'A1');
  assert.equal(cardsById.get('Eg_Prm').boardSource.slot, 'W1');
  assert.equal(cardsById.get('Ps_Zgr').boardSource.slot, 'BM3');
});

test('every nation has its resource board, exactly its two dynasties and only applicable nation FAQ', () => {
  const nations = catalog.cards.filter(card => card.type === 'nation');
  assert.equal(nations.length, 17);
  const renderer = bank();
  const entries = read('faq/entries.json').entries;
  for (const nation of nations) {
    const reply = renderer.render(nation.id, 'sv-SE');
    assert.equal(reply.messages[0].embeds[0].image.url, origin + '/card-assets/' + nation.imageAsset);
    assert.equal(nation.boardStartingResources, true);
    const file = manifest.files.find(file => file.cardId === nation.id);
    assert.equal(file.sourceFile, 'Reference/Nations_assets/PlayerBoard_start_' + nation.name + '.jpg');
    const body = readFileSync(new URL('../public/card-assets/' + file.filename, import.meta.url));
    assert.deepEqual([...body.subarray(0, 3)], [255,216,255]);
    assert.equal(createHash('sha256').update(body).digest('hex'), file.sourceSha256);
    assert.ok(reply.messages[0].embeds[1].description.includes(nation.boardSide + '-sida'));
    assert.equal(nation.boardSide, ['China','Egypt','Greece','Persia','Rome'].includes(nation.name) ? 'B' : 'D');
    const applicable = entries.filter(entry => entry.category === 'nation' && entry.heading.replace(/ B-side$/, '') === nation.name);
    for (const entry of applicable) assert.ok(reply.entryIds.includes(entry.id), nation.id + ': ' + entry.id);
    assert.ok(reply.entryIds.every(id=>entries.find(entry=>entry.id===id).category!=='dynasty'));
    const dynasties=catalog.cards.filter(card=>card.type==='dynasty'&&card.nation===nation.name);
    assert.equal(dynasties.length,2,nation.name);
    assert.deepEqual(reply.messages[0].embeds.slice(2).map(embed=>embed.title),dynasties.map(card=>card.name));
    assert.deepEqual(reply.imageTargets.map(target=>target.cardId),[nation.id,...dynasties.map(card=>card.id)]);
    for(const [index,dynasty] of dynasties.entries()) assert.equal(reply.messages[0].embeds[index+2].image.url,dynasty.imageCheck.url);
  }
  assert.equal(renderer.resolve('Kina').id, 'nation-China');
  assert.equal(renderer.resolve('Vikingarna').id, 'nation-Vikings');
  assert.equal(renderer.render('Japan').messages[0].embeds[0].title, 'Japan');
  assert.ok(renderer.render('Japan').entryIds.includes('nations-japan'));
  assert.equal(renderer.autocompleteNations('Kina')[0].value, 'nation-China');
  assert.equal(renderer.autocompleteNations('').length,17);
  assert.ok(renderer.autocomplete('Kina').every(choice=>choice.value!=='nation-China'));
  assert.equal(renderer.renderNation('Porcelain Tower').ok,false);
  assert.equal(renderer.renderNation('Kina').cardId,'nation-China');
  assert.throws(() => cardAssetOrigin({ NATIONS_CARD_ASSET_ORIGIN: 'http://example.test' }), /HTTPS/);
  assert.throws(() => cardAssetOrigin({ NATIONS_CARD_ASSET_ORIGIN: 'https://example.test/other' }), /HTTPS/);
});

test('public image server serves only manifest assets and never exposes admin, configuration or arbitrary files', async t => {
  const server = await startCardAssetServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.port;
  const path = '/card-assets/' + manifest.files[0].filename;
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), manifest.files[0].sha256);
  const head = await fetch(base + path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(Number(head.headers.get('content-length')), manifest.files[0].bytes);
  const cached = await fetch(base + path, { headers: { 'if-none-match': response.headers.get('etag') } });
  assert.equal(cached.status, 304);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(base + path, { method: 'POST', body: 'not-an-upload' })).status, 405);
  const board = manifest.files.find(file => file.cardId === 'nation-China');
  const boardReply = await fetch(base + '/card-assets/' + board.filename);
  assert.equal(boardReply.headers.get('content-type'), 'image/jpeg');
  assert.equal(createHash('sha256').update(Buffer.from(await boardReply.arrayBuffer())).digest('hex'), board.sha256);
  for (const other of ['/', '/api/status', '/auth/login', '/data/friends.json', '/.env.dev', '/card-assets/../.env.dev',
    '/card-assets/%2e%2e%2f.env.dev', '/card-assets/unknown.png', path + '?file=.env']) {
    const denied = await fetch(base + other);
    assert.equal(denied.status, 404, other);
    assert.equal(await denied.text(), '', other);
  }
});
