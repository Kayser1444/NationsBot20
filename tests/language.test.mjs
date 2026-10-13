import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translations, text, resolveLanguage, autocompleteLanguages } from '../language.mjs';
import { saveUserLocale, saveLanguagePreference, readBotLanguage, readLanguageOverride, saveDmPreference, saveSubscriptions } from '../subscriptions.mjs';
import { handleSubscriptionCommand, commands } from '../discord-commands.mjs';
import { turnMessage } from '../discord.mjs';

test('both translations cover the same messages, placeholders and commands', () => {
  assert.deepEqual(Object.keys(translations['sv-SE']).sort(), Object.keys(translations['en-US']).sort());
  for (const key of Object.keys(translations['sv-SE'])) {
    // Compare source placeholders because rendering intentionally removes unspecified values.
    assert.deepEqual(String(translations['sv-SE'][key]).match(/\{\w+\}/g)?.sort(), String(translations['en-US'][key]).match(/\{\w+\}/g)?.sort());
    assert.ok(text('sv-SE', key).length);
    assert.ok(text('en-US', key).length);
  }
  for (const language of ['sv-SE', 'en-US']) {
    const help = text(language, 'help');
    assert.ok(help.length <= 2000);
    for (const command of commands) assert.ok(help.includes('/' + command.name));
  }
});

test('automatic language follows Swedish or English variants, with English fallback', () => {
  assert.equal(resolveLanguage('sv-SE'), 'sv-SE');
  assert.equal(resolveLanguage('en-GB'), 'en-US');
  assert.equal(resolveLanguage('fr'), 'en-US');
  assert.equal(resolveLanguage(null), 'en-US');
  assert.equal(resolveLanguage('en-US', 'sv-SE'), 'sv-SE');
  assert.equal(resolveLanguage('sv-SE', 'en-US'), 'en-US');
  assert.equal(resolveLanguage('sv-SE', 'auto'), 'sv-SE');
  assert.deepEqual(autocompleteLanguages('swe').map(option => option.value), ['sv-SE']);
  assert.deepEqual(autocompleteLanguages('engelska').map(option => option.value), ['en-US']);
  assert.deepEqual(autocompleteLanguages('auto').map(option => option.value), ['auto']);
  assert.deepEqual(autocompleteLanguages('fr'), []);
});

test('language overrides survive restart, locale changes and subscription/DM edits', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nations-language-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'friends.json'), first = '111111111111111111', second = '222222222222222222';
  writeFileSync(path, JSON.stringify({ subscriptions: {}, matches: [], discord: {} }));
  saveUserLocale(path, first, 'en-US'); saveUserLocale(path, second, 'sv-SE');
  saveLanguagePreference(path, first, 'sv-SE');
  saveUserLocale(path, first, 'en-GB');
  saveDmPreference(path, first, true); saveSubscriptions(path, { Player: first }); saveSubscriptions(path, {});
  assert.equal(readBotLanguage(path, first), 'sv-SE');
  assert.equal(readBotLanguage(path, second), 'sv-SE');
  assert.equal(readLanguageOverride(path, first), 'sv-SE');
  const before = readFileSync(path, 'utf8');
  assert.throws(() => saveLanguagePreference(path, first, 'fr'));
  assert.equal(readFileSync(path, 'utf8'), before);
  saveLanguagePreference(path, first, 'auto');
  assert.equal(readLanguageOverride(path, first), null);
  assert.equal(readBotLanguage(path, first), 'en-US');
  assert.equal(JSON.parse(readFileSync(path)).dmPreferences[first], true);
});

test('language command immediately replies in the selected language, without requiring a subscription', () => {
  let locale = 'en-GB', override = null;
  const service = { getLocale: () => locale, getLanguageOverride: () => override,
    setLanguage: (_, value) => { override = value === 'auto' ? null : value; },
    getSubscriptions: () => ({ Player: '222222222222222222' }), getNames: () => ['Player'], commit: () => {} };
  const execute = args => handleSubscriptionCommand({ command: 'language', userId: '111111111111111111', ...args }, service);
  assert.match(execute({ locale: 'sv-SE' }), /Botens språk är nu svenska/);
  assert.match(execute({ command: 'help' }), /— hjälp/);
  assert.match(execute({ locale: 'fr' }), /Välj sv-SE/);
  assert.equal(override, 'sv-SE');
  assert.match(execute({ locale: 'en-US' }), /Your bot language is now English/);
  assert.match(execute({ command: 'help' }), /— help/);
  assert.match(execute({ command: 'notifications', action: 'on', nationsName: 'Player' }), /Player/);
  locale = 'sv-SE';
  assert.match(execute({ command: 'help' }), /— help/);
  assert.match(execute({ locale: 'auto' }), /Automatiskt språk är på/);
  assert.equal(override, null);
});

test('turn reminders translate without changing recipient, game link or mention rules', () => {
  const userId = '111111111111111111', match = { id: '123', title: 'Match @everyone' };
  const sv = turnMessage('Player', match, userId, 'sv-SE'), en = turnMessage('Player', match, userId, 'en-US');
  assert.match(sv.content, /Din tur i/); assert.match(en.content, /Your turn in/);
  assert.ok(en.content.includes('https://games.tabony.net/nations/123/'));
  assert.deepEqual(en.allowed_mentions, sv.allowed_mentions);
  assert.deepEqual(en.allowed_mentions, { parse: [], users: [userId] });
});
