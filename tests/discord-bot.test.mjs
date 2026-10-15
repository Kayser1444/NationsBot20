import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { Client, Events, GatewayIntentBits, MessageFlags, Routes } from 'discord.js';
import { handleSubscriptionCommand, autocompleteNames, commands, helpMessage } from '../discord-commands.mjs';
import { subscriptionEntries } from '../subscriptions.mjs';
import { startDiscordBot } from '../discord-bot.mjs';

const first = '229311536827465728', second = '821001820309815368';
test('help covers every registered command, fits one Discord message and needs no subscription access', () => {
  const content = handleSubscriptionCommand({ command: 'help' }, {
    getLocale: () => 'sv-SE',
    getSubscriptions: () => assert.fail('help must not read or modify subscriptions'),
    commit: () => assert.fail('help must not subscribe the caller'),
  });
  assert.equal(content, helpMessage);
  assert.ok(content.length <= 2000);
  for (const command of commands) assert.ok(content.includes('/' + command.name));
});
function fixture(names = ['Kayser', 'Suddoman']) {
  let subscriptions = {};
  const previousNames = {};
  const dmPreferences = {};
  const service = {
    getSubscriptions: () => subscriptions, getNames: () => names,
    getLocale: () => 'sv-SE',
    getPreviousName: userId => previousNames[userId] ?? null,
    getDm: userId => dmPreferences[userId] === true,
    setDm: (userId, enabled) => { dmPreferences[userId] = enabled; },
    commit: next => {
      for (const [name, id] of subscriptionEntries(subscriptions)) previousNames[id] = name;
      for (const [name, id] of subscriptionEntries(next)) previousNames[id] = name;
      subscriptions = next;
    },
    getStatus: () => ({ matches: 6, discordEnabled: true }),
  };
  return { service, execute: args => handleSubscriptionCommand({ command: 'notifications', action: 'on', userId: first, displayName: 'kayser', ...args }, service) };
}
test('on without a name restores the previous exact name; explicit choice updates it; other watchers do not reserve the name', () => {
  const f = fixture();
  f.execute({ nationsName: 'DifferentCase' });
  f.execute({ action: 'off' });
  assert.match(f.execute({ displayName: 'unmatched' }), /nu.*DifferentCase/);
  f.execute({ action: 'off' });
  f.execute({ nationsName: 'NewName' });
  f.execute({ action: 'off' });
  f.execute({ userId: second, nationsName: 'NewName' });
  assert.match(f.execute({ displayName: 'unmatched' }), /nu.*NewName/);
  assert.deepEqual(f.service.getSubscriptions().NewName, [second, first]);
});
test('Discord-name matching is case insensitive and stores exact Nations spelling', () => {
  const f = fixture();
  assert.match(f.execute({}), /nu.*Kayser/);
  assert.equal(f.service.getSubscriptions().Kayser, first);
  assert.equal(Object.hasOwn(f.service.getSubscriptions(), 'kayser'), false);
  assert.match(f.execute({ nationsName: 'kayser' }), /exakta namnet.*Kayser/);
});
test('DM defaults off, is independent from subscriptions, and is included in personal status', () => {
  const f = fixture();
  assert.equal(f.service.getDm(first), false);
  assert.match(f.execute({ command: 'dm', action: 'on' }), /bara privat/);
  assert.deepEqual(f.service.getSubscriptions(), {});
  assert.match(f.execute({ command: 'status' }), /endast DM/);
  assert.match(f.execute({}), /endast som DM/);
  f.execute({ action: 'off' });
  assert.equal(f.service.getDm(first), true);
  assert.match(f.execute({}), /endast som DM/);
  f.execute({ command: 'dm', action: 'off' });
  assert.equal(f.service.getDm(first), false);
  assert.equal(f.service.getSubscriptions().Kayser, first);
});
test('ambiguous or missing automatic name never silently selects a different player', () => {
  assert.match(fixture(['Kayser', 'kayser']).execute({}), /Flera Nations-namn/);
  assert.match(fixture([]).execute({}), /matchar inget/);
  const f = fixture(['Kayser', 'kayser']);
  assert.match(f.execute({ nationsName: 'kayser' }), /nu.*kayser/);
  assert.equal(f.service.getSubscriptions().kayser, first);
});
test('automatic matching ignores the appended real name and preserves explicit Nations names', () => {
  const f = fixture(['Kayser', 'Kayser (Jonas Adolphson)']);
  assert.match(f.execute({ displayName: 'kayser (Jonas Adolphson)' }), /nu.*`Kayser`/);
  assert.deepEqual(Object.keys(f.service.getSubscriptions()), ['Kayser']);
  const explicit = fixture(['Kayser', 'Kayser (Jonas Adolphson)']);
  explicit.execute({ nationsName: 'Kayser (Jonas Adolphson)' });
  assert.deepEqual(Object.keys(explicit.service.getSubscriptions()), ['Kayser (Jonas Adolphson)']);
  assert.match(fixture(['Kayser', 'kayser']).execute({ displayName: 'Kayser (Jonas Adolphson)' }), /Flera Nations-namn/);
});
test('multiple users may watch one player while each user has one subscription', () => {
  const f = fixture(); f.execute({});
  assert.match(f.execute({ userId: second, nationsName: 'Kayser' }), /nu.*Kayser/);
  assert.match(f.execute({ nationsName: 'Suddoman' }), /Avsluta först/);
  assert.match(f.execute({}), /redan/);
  assert.deepEqual(f.service.getSubscriptions().Kayser, [first, second]);
  assert.equal(Object.keys(f.service.getSubscriptions()).length, 1);
  f.execute({ action: 'off' });
  assert.equal(f.service.getSubscriptions().Kayser, second);
});
test('unsubscribe affects only the caller; status is personal; explicit new names are allowed', () => {
  const f = fixture(); f.execute({}); f.execute({ userId: second, nationsName: 'Suddoman' });
  assert.match(f.execute({ command: 'status' }), /Kayser.*6/);
  assert.match(f.execute({ command: 'notifications', action: 'off' }), /Kayser.*avslutad/);
  assert.equal(f.service.getSubscriptions().Suddoman, second);
  assert.match(f.execute({ command: 'status' }), /ingen prenumeration/);
  assert.match(f.execute({ nationsName: 'NewPlayer' }), /nu.*NewPlayer/);
});
test('autocomplete preserves case, prioritizes prefixes, and respects Discord limits', () => {
  assert.deepEqual(autocompleteNames(['aKayser', 'Kayser', 'kayser', 'Kayser'], 'KAY').map(item => item.value), ['kayser', 'Kayser', 'aKayser']);
  assert.equal(autocompleteNames(Array.from({ length: 30 }, (_, i) => 'Player' + i), '').length, 25);
  assert.deepEqual(autocompleteNames(['X'.repeat(101)], ''), []);
});

test('adapter supports all servers and restricts channel delivery to the SM reminder channel', async t => {
  let clock = 0;
  let instance; const registered = [], states = [], deleted = [];
  const dmChecks = [];
  class FakeClient extends EventEmitter {
    constructor(options) { super(); this.options = options; this.guilds = { cache: new Map([['guild', {}], ['another-server', {}]]) }; this.application = { id: 'application' }; this.rest = {
      get: async route => route.includes('/members/') ? { user: { id: second, username: 'friend-account' }, nick: 'Friendly Discord name' }
        : [{ name: 'prenumerera', type: 1, id: 'old-on' }, { name: 'avprenumerera', type: 1, id: 'old-off' }, { name: 'hjälp', type: 1, id: 'old-help' }, { name: 'other', type: 1, id: 'keep' }],
      delete: async route => deleted.push(route),
      post: async (route, options) => registered.push({ route, ...options }),
    }; instance = this; }
    async login() { this.emit(Events.ClientReady); }
    destroy() { this.destroyed = true; }
  }
  const f = fixture();
  f.service.checkDm = async userId => { dmChecks.push(userId); };
  const capturedLocales = [];
  f.service.captureLocale = (userId, locale) => capturedLocales.push({ userId, locale });
  f.service.getLocale = userId => capturedLocales.findLast(item => item.userId === userId)?.locale ?? null;
  const languageOverrides = {};
  f.service.getLanguageOverride = userId => languageOverrides[userId] ?? null;
  f.service.setLanguage = (userId, locale) => { if (locale === 'auto') delete languageOverrides[userId]; else languageOverrides[userId] = locale; };
  const bot = startDiscordBot({ token: 'not-a-real-token', guildId: 'guild', channelId: 'channel', service: f.service, now: () => clock,
    questions: { ask: async ({ userId, question, language }) => `Answer ${userId} ${question} ${language}`, close() {} },
    prepareImage: async reply => reply.messages[0],
    onState: state => states.push(state), loadLibrary: async () => ({ Client: FakeClient, Events, GatewayIntentBits, MessageFlags, Routes }),
  });
  t.after(() => bot.close());
  await bot.ready; await setImmediate();
  assert.deepEqual(instance.options.intents, [GatewayIntentBits.Guilds]);
  assert.deepEqual(registered.map(item => item.body.name), ['question', 'reminders', 'smtable', 'notifications', 'status', 'help', 'language', 'card', 'nation']);
  assert.deepEqual(registered.find(item => item.body.name === 'notifications').body.options.map(option => option.name), ['on', 'off']);
  assert.deepEqual(deleted.map(route => route.split('/').at(-1)), ['old-on', 'old-off', 'old-help']);
  assert.ok(states.includes('Igång'));
  const makeInteraction = (overrides = {}) => {
    const replies = [];
    return { replies, guildId: 'guild', channelId: 'channel', commandName: 'notifications', locale: 'sv-SE',
      user: { id: first, bot: false, username: 'other', globalName: 'unmatched' }, member: { nick: 'kayser (Jonas Adolphson)' },
      options: { getString: () => null, getSubcommand: () => 'on' }, isChatInputCommand: () => true, isAutocomplete: () => false,
      deferReply: async function(options) { this.deferred = true; replies.push(options); },
      editReply: async options => replies.push(options), ...overrides };
  };
  const blocked = makeInteraction({ channelId: 'other', options: { getString: name => name === 'dm' ? 'off' : null, getSubcommand: () => 'on' } });
  await instance.listeners(Events.InteractionCreate)[0](blocked);
  assert.deepEqual(f.service.getSubscriptions(), {});
  assert.match(blocked.replies[1].content, /Kanalpåminnelser/); capturedLocales.length = 0;
  assert.equal(blocked.replies[0].flags, MessageFlags.Ephemeral);
  const interaction = makeInteraction();
  await instance.listeners(Events.InteractionCreate)[0](interaction);
  assert.equal(f.service.getSubscriptions().Kayser, first);
  assert.deepEqual(capturedLocales, [{ userId: first, locale: 'sv-SE' }]);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(interaction.replies[1].allowedMentions, { parse: [] });
  const question = makeInteraction({ commandName: 'question', options: { getString: () => 'Poland and Porcelain Tower?' } });
  await instance.listeners(Events.InteractionCreate)[0](question);
  assert.equal(question.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(question.replies[1].content, /Poland and Porcelain Tower/);
  assert.deepEqual(question.replies[1].allowedMentions, { parse: [] });
  const help = makeInteraction({ commandName: 'help' });
  await instance.listeners(Events.InteractionCreate)[0](help);
  assert.equal(help.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(help.replies[1].content, helpMessage);
  assert.deepEqual(help.replies[1].allowedMentions, { parse: [] });
  f.service.getSmTable = (div, userId) => `SM ${div ?? 'auto'} ${userId}`;
  const sm = makeInteraction({ commandName: 'smtable', channelId: 'another-server-channel', options: { getString: name => name === 'div' ? '2A' : null } });
  await instance.listeners(Events.InteractionCreate)[0](sm);
  assert.deepEqual(sm.replies[0], {});
  assert.equal(sm.replies[1].content, `SM 2A ${first}`);
  assert.deepEqual(sm.replies[1].allowedMentions, { parse: [] });
  const dmTables = [];
  f.service.sendSmTableDm = async (userId, content) => dmTables.push({ userId, content });
  const smDm = makeInteraction({ commandName: 'smtable', channelId: 'other', options: { getString: name => name === 'dm' ? 'on' : null } });
  await instance.listeners(Events.InteractionCreate)[0](smDm);
  assert.deepEqual(smDm.replies[0], {});
  assert.deepEqual(dmTables, []);
  assert.equal(smDm.replies[1].content, `SM auto ${first}`);
  f.service.sendSmTableDm = async () => { throw new Error('blocked'); };
  const blockedSmDm = makeInteraction({ commandName: 'smtable', options: smDm.options });
  await instance.listeners(Events.InteractionCreate)[0](blockedSmDm);
  assert.deepEqual(blockedSmDm.replies[0], {});
  assert.equal(blockedSmDm.replies[1].content, `SM auto ${first}`);
  const foreignSm = makeInteraction({ commandName: 'smtable', guildId: 'another-server' });
  await instance.listeners(Events.InteractionCreate)[0](foreignSm);
  assert.deepEqual(foreignSm.replies[0], {});
  assert.equal(foreignSm.replies[1].content, `SM auto ${first}`);
  const card = makeInteraction({ commandName: 'card', guildId: 'another-server', channelId: 'another-channel',
    options: { getString: () => 'PcTw' }, followUp: async payload => card.replies.push(payload) });
  await instance.listeners(Events.InteractionCreate)[0](card);
  assert.deepEqual(card.replies[0], {});
  assert.equal(card.replies[1].embeds[0].title, 'Porcelain Tower');
  assert.equal(card.replies.length, 2, 'collapsed card needs no follow-up messages');
  assert.match(card.replies[1].components[0].components[0].label, /Visa FAQ \(13\)/);
  assert.ok(card.replies.slice(1).every(reply => !reply.flags && reply.allowedMentions.parse.length === 0));
  const unknownCard = makeInteraction({ commandName: 'card', options: { getString: () => 'unknown' } });
  await instance.listeners(Events.InteractionCreate)[0](unknownCard);
  assert.equal(unknownCard.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(unknownCard.replies[1].content, /namnförslagen/);
  f.service.getStatus = () => ({ matches: 100, discordEnabled: true, matchList: Array.from({ length: 100 }, (_, i) => ({ id: String(3000 + i), title: 'Testparti ' + i, connected: i % 2 === 0 })) });
  const status = makeInteraction({ commandName: 'status', locale: 'en-US', followUp: async options => status.replies.push(options) });
  await instance.listeners(Events.InteractionCreate)[0](status);
  assert.ok(status.replies.length > 2);
  const statusPages = status.replies.slice(1);
  for (const page of statusPages) {
    assert.ok(page.content.length <= 2000);
    assert.deepEqual(page.allowedMentions, { parse: [] });
  }
  for (const page of statusPages.slice(1)) assert.equal(page.flags, MessageFlags.Ephemeral);
  const statusContent = statusPages.map(page => page.content).join('\n');
  assert.match(statusContent, /Bot language:.*`en-US`.*automatic/);
  assert.equal(statusContent.includes('Discord language:'), false);
  for (let i = 0; i < 100; i++) assert.ok(statusContent.includes(`ID ${3000 + i} ·`));
  assert.match(statusContent, /https:\/\/games.tabony.net\/nations\/3000\//);
  assert.match(statusContent, /disconnected/);
  assert.match(statusContent, /· connected/);
  f.service.commit({ ...f.service.getSubscriptions(), Suddoman: second });
  f.service.getStatus = () => ({ matches: 1, discordEnabled: true, matchList: [{ id: '1', title: 'Live', player: 'Suddoman', connected: true }] });
  const turnStatus = makeInteraction({ commandName: 'status', locale: 'en-US' });
  await instance.listeners(Events.InteractionCreate)[0](turnStatus);
  assert.match(turnStatus.replies[1].content, /Turn: Suddoman \[Friendly Discord name\]/);
  assert.deepEqual(turnStatus.replies[1].allowedMentions, { parse: [] });
  assert.equal(turnStatus.replies[0].flags, MessageFlags.Ephemeral);
  // The extra fixture subscription must not affect the following off-command test.
  const remaining = { ...f.service.getSubscriptions() }; delete remaining.Suddoman; f.service.commit(remaining);
  const dm = makeInteraction({ commandName: 'dm' });
  await instance.listeners(Events.InteractionCreate)[0](dm);
  assert.equal(f.service.getDm(first), true);
  assert.equal(dm.replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(dmChecks, [first]);
  assert.match(dm.replies[1].content, /kontroll-DM har skickats/);
  assert.deepEqual(dm.replies[1].allowedMentions, { parse: [] });
  const repeatedDm = makeInteraction({ commandName: 'dm' });
  await instance.listeners(Events.InteractionCreate)[0](repeatedDm);
  assert.deepEqual(dmChecks, [first], 'a repeated DM control is suppressed during cooldown');
  clock += 60001;
  f.service.checkDm = async () => { throw new Error('private token must never appear'); };
  const deniedDm = makeInteraction({ commandName: 'dm' });
  await instance.listeners(Events.InteractionCreate)[0](deniedDm);
  assert.equal(f.service.getDm(first), true);
  assert.match(deniedDm.replies[1].content, /Kontroll-DM kunde inte bekräftas/);
  assert.match(deniedDm.replies[1].content, /DM-valet är fortfarande på/);
  assert.equal(deniedDm.replies[1].content.includes('private token'), false);
  const dmOff = makeInteraction({ commandName: 'dm', options: { getString: () => null, getSubcommand: () => 'off' } });
  f.service.checkDm = () => assert.fail('off must not send a control DM');
  await instance.listeners(Events.InteractionCreate)[0](dmOff);
  assert.equal(f.service.getDm(first), false);
  assert.match(dmOff.replies[1].content, /DM är av/);
  const autocomplete = makeInteraction({ isChatInputCommand: () => false, isAutocomplete: () => true,
    options: { getFocused: () => ({ name: 'nationsname', value: 'KAY' }) }, respond: async value => { autocomplete.choices = value; } });
  await instance.listeners(Events.InteractionCreate)[0](autocomplete);
  assert.deepEqual(autocomplete.choices, [{ name: 'Kayser', value: 'Kayser' }]);
  f.service.isBanned = () => true;
  await instance.listeners(Events.InteractionCreate)[0](autocomplete);
  assert.deepEqual(autocomplete.choices, []);
  const bannedDm = makeInteraction({ commandName: 'dm' });
  f.service.checkDm = () => assert.fail('banned users must receive no control DM');
  await instance.listeners(Events.InteractionCreate)[0](bannedDm);
  assert.match(bannedDm.replies[1].content, /spärrad/);
  assert.equal(bannedDm.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(f.service.getDm(first), false);
  f.service.isBanned = () => false;
  const languageAutocomplete = makeInteraction({ commandName: 'language', isChatInputCommand: () => false, isAutocomplete: () => true,
    options: { getFocused: () => ({ name: 'locale', value: 'swe' }) }, respond: async value => { languageAutocomplete.choices = value; } });
  await instance.listeners(Events.InteractionCreate)[0](languageAutocomplete);
  assert.deepEqual(languageAutocomplete.choices.map(option => option.value), ['sv-SE']);
  const language = makeInteraction({ commandName: 'language', locale: 'sv-SE', options: { getString: name => name === 'locale' ? 'en-US' : null } });
  await instance.listeners(Events.InteractionCreate)[0](language);
  assert.equal(languageOverrides[first], 'en-US');
  assert.match(language.replies[1].content, /Your bot language is now English/);
  assert.equal(language.replies[0].flags, MessageFlags.Ephemeral);
  f.service.checkDm = async () => {};
  clock += 60001;
  const englishDm = makeInteraction({ commandName: 'dm' });
  await instance.listeners(Events.InteractionCreate)[0](englishDm);
  assert.match(englishDm.replies[1].content, /DM is on/);
  assert.match(englishDm.replies[1].content, /A test DM has been sent/);
  f.service.checkDm = async () => { throw new Error('secret must never appear'); };
  clock += 60001;
  const failedEnglishDm = makeInteraction({ commandName: 'dm' });
  await instance.listeners(Events.InteractionCreate)[0](failedEnglishDm);
  assert.match(failedEnglishDm.replies[1].content, /DM remains on/);
  assert.equal(failedEnglishDm.replies[1].content.includes('secret'), false);
  const blockedLanguage = makeInteraction({ commandName: 'language', channelId: 'other', options: { getString: () => 'en-US' } });
  await instance.listeners(Events.InteractionCreate)[0](blockedLanguage);
  assert.equal(languageOverrides[first], 'en-US');
  const off = makeInteraction({ options: { getString: () => null, getSubcommand: () => 'off' } });
  await instance.listeners(Events.InteractionCreate)[0](off);
  assert.equal(Object.keys(f.service.getSubscriptions()).length, 0);
  clock += 10001;
  f.service.checkDm = async () => {};
  const foreign = makeInteraction({ guildId: 'another-server', channelId: 'general' });
  await instance.listeners(Events.InteractionCreate)[0](foreign);
  assert.equal(f.service.getSubscriptions().Kayser, first);
  assert.equal(f.service.getDm(first), true, 'foreign subscription switches a saved channel choice to DM');
  const foreignOff = makeInteraction({ guildId: 'another-server', options: { getString: name => name === 'dm' ? 'off' : null, getSubcommand: () => 'on' } });
  await instance.listeners(Events.InteractionCreate)[0](foreignOff);
  assert.match(foreignOff.replies[1].content, /Channel reminders/);
  assert.equal(f.service.getDm(first), true);
  const duplicate = makeInteraction({ guildId: 'third-server' });
  await instance.listeners(Events.InteractionCreate)[0](duplicate);
  assert.deepEqual({ ...f.service.getSubscriptions() }, { Kayser: first });
  bot.close(); assert.equal(instance.destroyed, true);
});
test('missing library or bad token stays isolated from game monitoring and logs no secret', async () => {
  const messages = [], states = [];
  const bot = startDiscordBot({ token: 'secret', service: fixture().service,
    report: message => messages.push(message), onState: state => states.push(state),
    loadLibrary: async () => { throw new Error('secret'); } });
  await bot.ready; assert.equal(states.at(-1), 'Fel · behöver åtgärdas');
  assert.equal(messages.some(message => message.includes('secret')), false); bot.close();
});
test('installed Discord library can construct and stop a Guilds-only client without connecting', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  assert.equal(client.options.intents.has(GatewayIntentBits.MessageContent), false);
  await client.destroy();
});
