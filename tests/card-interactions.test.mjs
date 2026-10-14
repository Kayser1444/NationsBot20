import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { Events, GatewayIntentBits, MessageFlags, Routes } from 'discord.js';
import { startDiscordBot } from '../discord-bot.mjs';
import { cardBank } from '../card-bank.mjs';
import { createCardImageDelivery } from '../card-image-delivery.mjs';
import { readFileSync } from 'node:fs';

async function fixture(t, prepareImage = async reply => reply.messages[0]) {
  let client, banned = false, member = true;
  const requests = [], errors = [];
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.application = { id: 'app' };
      this.guilds = { cache: new Map([['guild', {}]]) };
      this.rest = {
        post: async () => ({}), delete: async () => {},
        get: async route => {
          requests.push(route);
          if (route.includes('/members/')) {
            if (!member) throw new Error('not a member');
            return { user: { id: 'user' } };
          }
          return [];
        },
      };
      client = this;
    }
    async login() { this.emit(Events.ClientReady); }
    destroy() {}
  }
  const service = { isBanned: () => banned, getLanguageOverride: () => null,
    getSubscriptions: () => assert.fail('FAQ buttons must not access subscriptions') };
  const bot = startDiscordBot({ token: 'fake', guildId: 'guild', channelId: 'channel', service,
    report: (message, level) => { if (level === 'error') errors.push(message); },
    loadLibrary: async () => ({ Client: FakeClient, Events, GatewayIntentBits, MessageFlags, Routes }), prepareImage });
  t.after(() => bot.close());
  await bot.ready;
  await setImmediate();
  async function click(customId, overrides = {}) {
    const calls = [];
    const interaction = {
      customId, guildId: 'guild', context: 0, locale: 'sv-SE',
      user: { id: 'user', bot: false }, message: { id: 'original-card', author: { id: 'app' } },
      isButton: () => true, isChatInputCommand: () => false, isAutocomplete: () => false,
      deferUpdate: async () => { interaction.deferred = true; calls.push({ type: 'ack' }); },
      editReply: async payload => calls.push({ type: 'update', payload }),
      followUp: async payload => calls.push({ type: 'private', payload }),
      ...overrides,
    };
    await client.listeners(Events.InteractionCreate)[0](interaction);
    return calls;
  }
  async function slashCard(overrides = {}) {
    const calls = [];
    const interaction = {commandName:'card',guildId:'guild',channelId:'channel',context:0,locale:'sv-SE',user:{id:'user'},
      options:{getString:()=> 'PcTw'}, isButton:()=>false,isChatInputCommand:()=>true,isAutocomplete:()=>false,
      deferReply:async()=>{interaction.deferred=true;calls.push({type:'ack'});},
      editReply:async payload=>calls.push({type:'update',payload}),followUp:async()=>assert.fail('No extra message'),...overrides};
    await client.listeners(Events.InteractionCreate)[0](interaction);
    return calls;
  }
  async function autocomplete(commandName,query){
    let choices;
    await client.listeners(Events.InteractionCreate)[0]({commandName,guildId:'guild',locale:'sv-SE',user:{id:'user'},
      isButton:()=>false,isChatInputCommand:()=>false,isAutocomplete:()=>true,
      options:{getFocused:()=>({name:'name',value:query})},respond:async value=>{choices=value;}});
    return choices;
  }
  return { click, slashCard, autocomplete, requests, errors, ban: () => { banned = true; }, deny: () => { member = false; } };
}
const openId = () => cardBank.render('PcTw', 'en-US').messages[0].components[0].components[0].custom_id;

test('slash nation supports public and DM replies, nation-only suggestions and FAQ edits retaining all three images',async t=>{
  const cards=JSON.parse(readFileSync(new URL('../data/cards/catalog.json',import.meta.url),'utf8')).cards;
  const prepare=createCardImageDelivery({cards,fetchImage:async()=>new Response(Buffer.from([255,216,255,217]),{headers:{'content-type':'image/jpeg'}})});
  const f=await fixture(t,prepare);
  assert.equal((await f.autocomplete('nation','')).length,17);
  assert.equal((await f.autocomplete('nation','Kina'))[0].value,'nation-China');
  assert.ok((await f.autocomplete('card','Kina')).every(choice=>choice.value!=='nation-China'));
  for(const context of [{guildId:'guild',context:0},{guildId:null,context:1}]){
    const calls=await f.slashCard({...context,commandName:'nation',options:{getString:()=> 'Kina'}});
    assert.deepEqual(calls.map(call=>call.type),['ack','update']);
    const message=calls[1].payload;
    assert.equal(message.embeds[0].title,'China');assert.equal(message.files.length,3);
    assert.deepEqual(message.embeds.slice(2).map(embed=>embed.title),['Ming Dynasty','Qin Dynasty']);
    const embeds=message.embeds.map(embed=>({...embed,...(embed.image?{image:{url:'https://cdn.discordapp.com/attachments/123/'+(1000+message.files.findIndex(file=>embed.image.url==='attachment://'+file.name))+'/'+embed.image.url.slice(13)}}:{})}));
    const opened=await f.click(message.components[0].components[0].custom_id,{message:{author:{id:'app'},embeds,attachments:new Map()}});
    assert.equal(opened[1].payload.files,undefined);assert.equal(opened[1].payload.attachments.length,3);
    assert.deepEqual(opened[1].payload.embeds.slice(0,4).map(embed=>embed.image?.url),message.embeds.map(embed=>embed.image?.url));
    assert.match(opened[1].payload.embeds.at(-1).description,/FAQ\+\+/);
    assert.ok(!/Kina: Qin Dynasty|Kina: Ming Dynasty/.test(opened[1].payload.embeds.at(-1).description));
  }
  const invalid=await f.slashCard({commandName:'nation',options:{getString:()=> 'PcTw'}});
  assert.match(invalid[1].payload.content,/Nationsnamnet/);
  f.ban();assert.deepEqual(await f.autocomplete('nation',''),[]);
  assert.match((await f.slashCard({commandName:'nation'}))[1].payload.content,/spärrad/);
  assert.deepEqual(f.errors,[]);
});

test('slash card uploads the image on the first edit and FAQ clicks keep its existing attachment',async t=>{
  const cards=JSON.parse(readFileSync(new URL('../data/cards/catalog.json',import.meta.url),'utf8')).cards;
  let downloads=0;
  const prepare=createCardImageDelivery({cards,fetchImage:async()=>{downloads++;return new Response(Buffer.from([255,216,255,217]),{headers:{'content-type':'image/jpeg'}});}});
  const f=await fixture(t,prepare);
  const initial=await f.slashCard();
  assert.deepEqual(initial.map(call=>call.type),['ack','update']);
  assert.equal(initial[1].payload.embeds[0].image.url,'attachment://card-PcTw.jpg');
  assert.ok(initial[1].payload.files[0].attachment.length);
  const opened=await f.click(openId(),{message:{author:{id:'app'},attachments:new Map([['image',{id:'image',name:'card-PcTw.jpg'}]])}});
  assert.deepEqual(opened[1].payload.attachments,[{id:'image',filename:'card-PcTw.jpg'}]);
  assert.equal(opened[1].payload.files,undefined);
  assert.equal(downloads,1);
  const withoutUploadPermission=await f.slashCard({appPermissions:{has:permission=>permission !== 'AttachFiles'}});
  assert.equal(withoutUploadPermission[1].payload.files,undefined);
  assert.match(withoutUploadPermission[1].payload.embeds[0].image.url,/^https:\/\/games.tabony.net\//);
  const hidden=await f.click(openId(),{message:{author:{id:'app'},attachments:new Map(),embeds:[{image:{url:'https://cdn.discordapp.com/attachments/123/456/card-PcTw.jpg?ex=temporary'}}]}});
  assert.equal(hidden[1].payload.files,undefined);
  assert.deepEqual(hidden[1].payload.attachments,[{id:'456',filename:'card-PcTw.jpg'}]);
  assert.equal(hidden[1].payload.embeds[0].image.url,'attachment://card-PcTw.jpg');
  assert.equal(downloads,1);
  assert.deepEqual(f.errors,[]);
});

test('FAQ buttons update the original card, preserve its language, and collapse without follow-ups', async t => {
  const f = await fixture(t);
  const opened = await f.click(openId());
  assert.deepEqual(opened.map(call => call.type), ['ack', 'update']);
  assert.equal(opened[1].payload.embeds[0].title, 'Porcelain Tower');
  assert.match(opened[1].payload.embeds[2].description, /French Revolution/);
  assert.match(opened[1].payload.embeds[2].description, /FAQ\+\+ 1.11.*points/);
  assert.deepEqual(opened[1].payload.allowedMentions, { parse: [], users: [], roles: [] });
  const closeId = opened[1].payload.components[0].components[0].custom_id;
  const closed = await f.click(closeId);
  assert.deepEqual(closed.map(call => call.type), ['ack', 'update']);
  assert.equal(closed[1].payload.embeds.length, 2);
  assert.match(closed[1].payload.components[0].components[0].label, /Show FAQ/);
  assert.deepEqual(f.errors, []);
});

test('DM buttons acknowledge before rechecking membership and keep denials private', async t => {
  const f = await fixture(t);
  const opened = await f.click(openId(), { guildId: null, context: 1 });
  assert.deepEqual(opened.map(call => call.type), ['ack', 'update']);
  assert.ok(f.requests.some(route => route.includes('/members/')));
  f.deny();
  const denied = await f.click(openId(), { guildId: null, context: 1 });
  assert.deepEqual(denied.map(call => call.type), ['ack', 'private']);
  assert.equal(denied[1].payload.flags, MessageFlags.Ephemeral);
  assert.match(denied[1].payload.content, /Medlemskapet/);
});

test('bans, foreign messages and unavailable buttons cannot replace the shared card', async t => {
  const f = await fixture(t);
  for (const [id, options] of [
    ['cardfaq:1:PcTw:en-US:9999', {}],
    ['cardfaq:2:PcTw:en-US:0', {}],
    [openId(), { message: { author: { id: 'another-bot' } } }],
    [openId(), { guildId: 'uninstalled-guild' }],
  ]) {
    const calls = await f.click(id, options);
    assert.deepEqual(calls.map(call => call.type), ['ack', 'private']);
    assert.equal(calls[1].payload.flags, MessageFlags.Ephemeral);
  }
  f.ban();
  const banned = await f.click(openId());
  assert.deepEqual(banned.map(call => call.type), ['ack', 'private']);
  assert.match(banned[1].payload.content, /spärrad/);
  assert.deepEqual(await f.click('unrelated-button'), []);
  assert.deepEqual(f.errors, []);
});
