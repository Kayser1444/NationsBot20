import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {cardBank,createCardBank} from '../card-bank.mjs';
import {prepareCardImage} from '../card-image-delivery.mjs';
const read=path=>JSON.parse(readFileSync(new URL('../data/'+path,import.meta.url),'utf8'));
const catalog=read('cards/catalog.json');
const promos=read('cards/promos.json').cards;
const files=read('cards/asset-manifest.json').files;

test('promo scans keep existing FAQ identities, show type/era and the Tabony note, and upload real local images',async()=>{
  assert.equal(catalog.cards.length,526);
  assert.equal(promos.length,13);
  assert.equal(cardBank.resolve('Engineering Genius').age,2);
  assert.match(cardBank.render('Engineering Genius','sv-SE').messages[0].embeds[1].description,/Era II\*\*/);
  const bank=createCardBank({catalog,sources:read('faq/sources.json'),entries:read('faq/entries.json'),assetOrigin:'https://cards.example.test'});
  for(const spec of promos){
    const card=catalog.cards.find(card=>card.id===spec.id);
    assert.equal(card.promo,true,card.id);assert.equal(card.tabonyImplemented,false,card.id);
    assert.equal(card.type,spec.type);assert.equal(card.age,spec.age);
    for(const locale of ['sv-SE','en-US']){
      const reply=bank.render(card.id,locale);
      assert.equal(reply.ok,true);
      const metadata=reply.messages[0].embeds[1].description;
      assert.ok(metadata.includes(['I','II','III','IIII'][spec.age-1]));
      assert.match(metadata,locale==='sv-SE'?/Promo-kort.*Tabonys spelimplementation/:/Promo card.*Tabony game implementation/);
      const message=await prepareCardImage(reply);
      if(!spec.sourceFile){assert.equal(message.files,undefined);continue;}
      const file=files.find(file=>file.cardId===spec.id);
      assert.equal(file.filename,card.imageAsset);
      assert.match(message.embeds[0].image.url,/^attachment:\/\//);
      const bytes=message.files[0].attachment;
      assert.equal(bytes.readUInt32BE(16),164);assert.equal(bytes.readUInt32BE(20),254);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
      assert.deepEqual(bytes,readFileSync(new URL('../public/card-assets/'+file.filename,import.meta.url)));
    }
  }
  assert.equal(promos.filter(card=>card.sourceFile).length,12);
  assert.equal(cardBank.resolve('Solar Eclipse').id,cardBank.resolve('Spring and Autumn Period').id);
  assert.equal(cardBank.resolve('Potëmkin Village').id,'promo-potemkin-village');
  for(const [name,id] of [['Tesla','faq-nikola-tesla'],['Hagia Sophia','faq-hagia-sophia'],['Mechanical Turk','faq-mechanical-turk']]){
    assert.equal(cardBank.resolve(name).id,id);
    assert.ok(cardBank.render(id).entryIds.length);
  }
  const missing=catalog.cards.filter(card=>!card.imageAsset&&!(card.imageCheck?.status===200&&card.imageUrl===card.imageCheck.url));
  assert.deepEqual(missing.map(card=>card.name),['Hussar']);
});
