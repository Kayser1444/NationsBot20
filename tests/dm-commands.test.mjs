import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { Events, GatewayIntentBits, MessageFlags, Routes } from 'discord.js';
import { startDiscordBot } from '../discord-bot.mjs';
const userId = '229311536827465728';
async function fixture(t) {
  let client, onlyForeign = false, member = true, banned = false, lookups = 0, subscriptions = {}, reads = 0;
  const registered = [], deleted = [], sent = [];
  class FakeClient extends EventEmitter {
    constructor(options) { super(); this.options = options; this.guilds = { cache: new Map([['guild', {}], ['another-server', {}]]) }; this.application = { id: 'app' }; this.rest = {
      post: async (route, payload) => registered.push({ route, ...payload }),
      get: async route => {
        if (route.includes('/members/')) { lookups++; if (onlyForeign && route.includes('/guilds/guild/')) throw new Error('not an SM member'); if (!member) throw new Error('unknown member'); return { user: { id: userId }, nick: 'Kayser (Owner)' }; }
        return [{ type: 1, name: 'smtable', id: 'old-table' }, { type: 1, name: 'notifications', id: 'old-notifications' }, { type: 1, name: 'foreign', id: 'keep' }];
      },
      delete: async route => deleted.push(route),
    }; client = this; }
    async login() { this.emit(Events.ClientReady); }
    destroy() {}
  }
  const service = {
    isBanned: () => banned, getSubscriptions: () => { reads++; return subscriptions; },
    getNames: () => ['Kayser'], commit: next => { subscriptions = next; },
    getLocale: () => 'sv-SE', getStatus: () => ({ matches: 0, discordEnabled: true }),
    getSmTable: div => `SM ${div ?? 'auto'}`, sendSmTableDm: async (...args) => sent.push(args),
    getDm: () => false, setDm: () => {}, checkDm: async () => {}, setLanguage: () => {},
  };
  const bot = startDiscordBot({ token: 'fake', guildId: 'guild', channelId: 'channel', service,
    loadLibrary: async () => ({ Client: FakeClient, Events, GatewayIntentBits, MessageFlags, Routes }) });
  t.after(() => bot.close()); await bot.ready; await setImmediate();
  async function run(command, options = {}) {
    const replies = [];
    const interaction = { commandName: command, guildId: null, context: 1, channelId: 'dm', locale: 'sv-SE',
      user: { id: userId, bot: false, username: 'unmatched' },
      options: { getString: name => options[name] ?? null, getSubcommand: () => options.action ?? 'on', getFocused: () => ({ name: 'nationsname', value: 'Kay' }) },
      isChatInputCommand: () => !options.autocomplete, isAutocomplete: () => !!options.autocomplete,
      deferReply: async payload => { interaction.deferred = true; replies.push(payload); },
      editReply: async payload => replies.push(payload), respond: async payload => replies.push(payload),
      followUp: async payload => replies.push(payload),
    };
    await client.listeners(Events.InteractionCreate)[0](interaction); return replies;
  }
  return { run, registered, deleted, sent, client, service, foreignOnly: () => { onlyForeign = true; }, deny: () => { member = false; }, ban: () => { banned = true; }, counts: () => ({ lookups, reads }), subscriptions: () => subscriptions };
}
test('global commands support server and bot DM, while old owned guild registrations are removed', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.client.options.intents, [GatewayIntentBits.Guilds]);
  for (const command of f.registered) { assert.equal(command.route, Routes.applicationCommands('app')); assert.deepEqual(command.body.contexts, [0, 1]); assert.deepEqual(command.body.integration_types, [0]); }
  assert.deepEqual(f.deleted.map(route => route.split('/').at(-1)), ['old-table', 'old-notifications']);
});

test('card replies in DM use the FAQ bank, membership check and bans without reading subscriptions', async t => {
  const f = await fixture(t);
  f.foreignOnly();
  const reply = await f.run('card', { name: 'PcTw' });
  assert.deepEqual(reply[0], {});
  assert.equal(reply[1].embeds[0].title, 'Porcelain Tower');
  assert.equal(reply.length, 2, 'FAQ is shown in the same DM message');
  assert.match(reply[1].components[0].components[0].label, /Dölj FAQ/);
  assert.ok(reply.every(part => !part.flags));
  assert.equal(f.counts().reads, 0);
  f.deny();
  assert.match((await f.run('card', { name: 'PcTw' }))[1].content, /Medlemskapet/);
  f.ban();
  assert.match((await f.run('card', { name: 'PcTw' }))[1].content, /spärrad/);
});
test('SM replies directly in DM regardless of dm:on and general commands use membership nickname', async t => {
  const f = await fixture(t);
  const rows = await f.run('smtable', { div: '2A', dm: 'on' });
  assert.deepEqual(rows[0], {}); assert.equal(rows[1].content, 'SM 2A'); assert.deepEqual(f.sent, []);
  const on = await f.run('notifications'); assert.match(on[1].content, /Kayser/);
  assert.equal(f.subscriptions().Kayser, userId);
  const status = await f.run('status'); assert.match(status[1].content, /Kayser/);
  const off = await f.run('notifications', { action: 'off' }); assert.match(off[1].content, /avslutad/);
  const dm = await f.run('dm'); assert.match(dm[1].content, /DM är på/);
  const language = await f.run('language', { locale: 'sv-SE' }); assert.match(language[1].content, /svenska/);
  const help = await f.run('help'); assert.match(help[1].content, /smtable/);
});
test('DM membership failure and bans deny commands before subscription access', async t => {
  const f = await fixture(t); f.deny();
  const denied = await f.run('notifications'); assert.match(denied[1].content, /Medlemskapet kunde inte verifieras/);
  assert.equal(f.counts().reads, 0);
  const before = f.counts().lookups; f.ban();
  const banned = await f.run('smtable'); assert.match(banned[1].content, /spärrad/);
  assert.equal(f.counts().lookups, before); assert.equal(f.counts().reads, 0);
});
test('DM autocomplete requires current membership and provides exact Nations spelling', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run('notifications', { autocomplete: true }), [[{ name: 'Kayser', value: 'Kayser' }]]);
  f.deny(); assert.deepEqual(await f.run('notifications', { autocomplete: true }), [[]]);
});

test('SM commands pass the effective language override, falling back to the interaction locale', async t => {
  const f = await fixture(t);
  f.service.getSmTable = (div, id, language) => language;
  f.service.getLanguageOverride = () => 'en-US';
  assert.equal((await f.run('smtable'))[1].content, 'en-US');
  f.service.getLanguageOverride = () => null;
  assert.equal((await f.run('smtable'))[1].content, 'sv-SE');
});

test('DM accepts membership exclusively in another installed community', async t => {
  const f = await fixture(t); f.foreignOnly();
  assert.equal((await f.run('smtable'))[1].content, 'SM auto');
  assert.equal(f.counts().lookups, 2);
});

test('DM cannot disable private delivery and rejection does not create a subscription', async t => {
  const f = await fixture(t);
  assert.match((await f.run('notifications', { dm: 'off' }))[1].content, /Kanalpåminnelser/);
  assert.deepEqual(f.subscriptions(), {});
});
