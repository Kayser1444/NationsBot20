import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { Events, GatewayIntentBits, MessageFlags, Routes } from 'discord.js';
import { startDiscordBot } from '../discord-bot.mjs';
import { cardBank } from '../card-bank.mjs';

async function fixture(t) {
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
    loadLibrary: async () => ({ Client: FakeClient, Events, GatewayIntentBits, MessageFlags, Routes }) });
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
  return { click, requests, errors, ban: () => { banned = true; }, deny: () => { member = false; } };
}
const openId = () => cardBank.render('PcTw', 'en-US').messages[0].components[0].components[0].custom_id;

test('FAQ buttons update the original card, preserve its language, and collapse without follow-ups', async t => {
  const f = await fixture(t);
  const opened = await f.click(openId());
  assert.deepEqual(opened.map(call => call.type), ['ack', 'update']);
  assert.equal(opened[1].payload.embeds[0].title, 'Porcelain Tower');
  assert.match(opened[1].payload.embeds[2].description, /French Revolution/);
  assert.match(opened[1].payload.embeds[2].description, /English summary/);
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
