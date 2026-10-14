import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardBank } from '../card-bank.mjs';
import { createCardImageDelivery } from '../card-image-delivery.mjs';
const cards = JSON.parse(readFileSync(new URL('../data/cards/catalog.json',import.meta.url),'utf8')).cards;
const jpeg = Buffer.from([255,216,255,224,0,2,255,217]);
const response = () => new Response(jpeg,{headers:{'content-type':'image/jpeg'}});

test('first reply contains image bytes before any FAQ click; FAQ edits reuse the attachment after restart', async () => {
  let downloads = 0;
  const prepare = createCardImageDelivery({cards,fetchImage:async()=>{downloads++;return response();}});
  const reply = cardBank.render('PcTw','sv-SE');
  const before = JSON.stringify(reply);
  const initial = await prepare(reply);
  assert.equal(initial.embeds[0].image.url,'attachment://card-PcTw.jpg');
  assert.deepEqual(initial.files[0].attachment,jpeg);
  assert.equal(initial.embeds[0].url,reply.messages[0].embeds[0].url,'preserve source link');
  assert.equal(initial.components[0].components[0].custom_id,reply.messages[0].components[0].components[0].custom_id);
  assert.equal(JSON.stringify(reply),before,'do not mutate reusable render data');
  assert.equal(downloads,1);
  const afterRestart = createCardImageDelivery({cards,fetchImage:async()=>assert.fail('FAQ should not fetch another image')});
  const attachment = {id:'123',name:'card-PcTw.jpg'};
  const opened = await afterRestart(cardBank.render('PcTw','sv-SE',{faqPage:0}),{attachments:[attachment]});
  assert.equal(opened.embeds[0].image.url,initial.embeds[0].image.url);
  assert.deepEqual(opened.attachments,[{id:'123',filename:'card-PcTw.jpg'}]);
  assert.equal(opened.files,undefined);
  const closed = await afterRestart(reply,{attachments:[attachment]});
  assert.deepEqual(closed.attachments,opened.attachments);
});

test('local starting cards and resource boards upload directly without HTTP',async()=>{
  const prepare=createCardImageDelivery({cards,fetchImage:async()=>assert.fail('No HTTP for local assets')});
  for(const id of ['J_Epr','nation-China']){
    const card=cards.find(card=>card.id===id);
    const message=await prepare(cardBank.render(id));
    assert.equal(message.embeds[0].image.url,'attachment://'+card.imageAsset);
    assert.ok(!message.embeds[1].description.includes('not available'));
    assert.deepEqual(message.files[0].attachment,readFileSync(new URL('../public/card-assets/'+card.imageAsset,import.meta.url)));
  }
});

test('Discord hides embedded uploads from attachments; FAQ must reuse the CDN image without another upload',async()=>{
  const prepare=createCardImageDelivery({cards,fetchImage:async()=>response()});
  const imageUrl='https://cdn.discordapp.com/attachments/123/456/card-PcTw.jpg?ex=temporary&hm=signature';
  const message=await prepare(cardBank.render('PcTw','sv-SE',{faqPage:0}),{attachments:[],imageUrl});
  assert.equal(message.files,undefined,'hidden embedded uploads must not be downloaded and uploaded again');
  assert.equal(message.attachments,undefined,'omit attachments to preserve the hidden embedded file');
  assert.equal(message.embeds[0].image.url,'https://cdn.discordapp.com/attachments/123/456/card-PcTw.jpg');
  for(const unrelated of ['https://example.test/attachments/123/456/card-PcTw.jpg','https://cdn.discordapp.com/attachments/123/456/other.jpg']){
    assert.ok((await prepare(cardBank.render('PcTw'),{imageUrl:unrelated})).files);
  }
});

test('concurrent requests coalesce, cache is bounded, and failed or invalid downloads keep the source image',async()=>{
  let downloads=0, release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const prepare=createCardImageDelivery({cards,cacheBytes:jpeg.length,fetchImage:async()=>{downloads++;await waiting;return response();}});
  const first=prepare(cardBank.render('PcTw')),second=prepare(cardBank.render('PcTw'));
  release(); await Promise.all([first,second]);assert.equal(downloads,1);
  await prepare(cardBank.render('PcTw'));assert.equal(downloads,1);
  await prepare(cardBank.render('UTC'));assert.equal(downloads,2);
  await prepare(cardBank.render('PcTw'));assert.equal(downloads,3,'old cache item evicted');
  for(const fetchImage of [async()=>{throw new Error('offline');},async()=>new Response('html',{headers:{'content-type':'text/html'}}),
    async()=>new Response(jpeg,{headers:{'content-type':'image/jpeg','content-length':'9999999'}}),
    async()=>new Response('wrong bytes',{headers:{'content-type':'image/jpeg'}})]){
    const fallback=createCardImageDelivery({cards,fetchImage});
    const reply=cardBank.render('PcTw');
    assert.deepEqual(await fallback(reply),reply.messages[0]);
  }
  let attempts=0;
  const recover=createCardImageDelivery({cards,fetchImage:async()=>{if(++attempts===1)throw new Error('temporary');return response();}});
  await recover(cardBank.render('PcTw'));
  assert.ok((await recover(cardBank.render('PcTw'))).files);
});

test('dynasties identify their nation in metadata and suggestions',()=>{
  const dynasties=cards.filter(card=>card.type==='dynasty');
  assert.equal(dynasties.length,34);
  const nationNames=new Set(cards.filter(card=>card.type==='nation').map(card=>card.name));
  for(const card of dynasties){
    assert.ok(nationNames.has(card.nation),card.id);
    for(const language of ['sv-SE','en-US']){
      assert.ok(cardBank.render(card.id,language).messages[0].embeds[1].description.includes('· '+card.nation));
      assert.ok(cardBank.autocomplete(card.name,language).find(choice=>choice.value===card.id).name.includes('· '+card.nation));
    }
  }
  assert.match(cardBank.render('Am_DR','sv-SE').messages[0].embeds[1].description,/Dynasti · America/);
});
