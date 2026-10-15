import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnJournal, DAY, reminderOptions, reminderSlot } from '../turn-journal.mjs';
import { saveReminderPreference, readReminderPreferences, saveSubscriptions } from '../subscriptions.mjs';
import { translations, resolveLanguage, text } from '../language.mjs';
import { handleSubscriptionCommand } from '../discord-commands.mjs';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nations-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-15T10:00:00Z');
  return { path: join(directory, 'turns.json'), config: join(directory, 'config.json'), now: () => now, advance: ms => { now += ms; } };
}
const state = (player, move, over = false) => ({ player, move, over });
test('24h reminders persist receipts, reset on player change and stop on game completion', t => {
  const f = fixture(t); let journal = new TurnJournal(f.path, f.now);
  journal.observe('1', state('A', 1));
  const preference = { enabled: true, ...reminderOptions() };
  assert.equal(journal.due('1', 'user', preference), null);
  f.advance(DAY); const first = journal.due('1', 'user', preference); assert.ok(first); journal.receipt(first);
  journal = new TurnJournal(f.path, f.now); assert.equal(journal.due('1', 'user', preference), null);
  journal.observe('1', state('A', 2)); assert.equal(journal.due('1', 'user', preference), null);
  f.advance(DAY); assert.ok(journal.due('1', 'user', preference));
  journal.observe('1', state('B', 3)); assert.equal(journal.due('1', 'user', preference), null);
  f.advance(DAY); journal.observe('1', state(null, 4, true)); assert.equal(journal.due('1', 'user', preference), null);
});
test('fixed times use GMT by default and follow timezone DST once per local date', () => {
  assert.equal(reminderOptions('18:00').timezone, 'Etc/GMT');
  assert.throws(() => reminderOptions('24:00')); assert.throws(() => reminderOptions('12:00', 'invalid'));
  const turn = { player: 'A', startedAt: Date.parse('2026-10-24T00:00:00Z') };
  const p = { enabled: true, ...reminderOptions('02:30', 'Europe/Stockholm') };
  assert.equal(reminderSlot(turn, p, Date.parse('2026-10-25T00:30:00Z')), '2026-10-25');
  assert.equal(reminderSlot(turn, p, Date.parse('2026-10-25T01:30:00Z')), '2026-10-25');
  const spring = { player: 'A', startedAt: Date.parse('2026-03-28T00:00:00Z') };
  assert.equal(reminderSlot(spring, p, Date.parse('2026-03-29T01:00:00Z')), '2026-03-29');
  assert.equal(reminderSlot({ player: 'A', startedAt: Date.parse('2026-10-15T20:00:00Z') }, { enabled: true, ...reminderOptions('18:00') }, Date.parse('2026-10-15T21:00:00Z')), null);
});
test('selected games log all players, consecutive moves, completion and partial first intervals', t => {
  const f = fixture(t); const journal = new TurnJournal(f.path, f.now);
  journal.observe('2', state('A', 1)); journal.track('1', true); journal.observe('1', state('A', 1));
  f.advance(1000); journal.observe('1', state('A', 1)); assert.equal(journal.data.records.length, 0);
  f.advance(1000); journal.observe('1', state('A', 2));
  f.advance(3000); journal.observe('1', state('B', 3));
  f.advance(4000); journal.observe('1', state(null, 4, true));
  assert.deepEqual(journal.data.records.map(r => [r.player, r.durationMs, r.partial]), [['A', 2000, true], ['A', 3000, false], ['B', 4000, false]]);
  assert.equal(new TurnJournal(f.path, f.now).data.records.length, 3);
  journal.track('2', true); f.advance(5000); journal.track('2', false);
  assert.equal(journal.data.records.at(-1).partial, true);
  assert.equal(journal.data.records.at(-1).reason, 'disabled');
});
test('reminders keep their own mapping and survive notifications off and re-enable', t => {
  const f = fixture(t), userId = '111111111111111111';
  writeFileSync(f.config, JSON.stringify({ subscriptions: { A: userId }, discord: {} }));
  const service = { getSubscriptions: () => ({}), getNames: () => ['A'], getReminders: id => readReminderPreferences(f.config)[id], setReminders: (id, p) => saveReminderPreference(f.config, id, p) };
  handleSubscriptionCommand({ command: 'reminders', action: 'on', userId, displayName: 'A' }, service);
  saveSubscriptions(f.config, {});
  assert.equal(readReminderPreferences(f.config)[userId].enabled, true);
  handleSubscriptionCommand({ command: 'reminders', action: 'off', userId }, service);
  assert.equal(readReminderPreferences(f.config)[userId].enabled, false);
  handleSubscriptionCommand({ command: 'reminders', action: 'on', userId, displayName: 'Changed' }, service);
  assert.equal(readReminderPreferences(f.config)[userId].name, 'A');
  assert.equal(readReminderPreferences(f.config)[userId].enabled, true);
});
test('every language covers all messages and placeholders, with automatic regional matching', () => {
  const source = translations['en-US'];
  for (const [language, messages] of Object.entries(translations)) {
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(source).sort(), language);
    for (const key of Object.keys(source)) assert.deepEqual(String(messages[key]).match(/\{\w+\}/g)?.sort(), String(source[key]).match(/\{\w+\}/g)?.sort(), language + ':' + key);
    assert.ok(text(language, 'help').length < 2000);
  }
  for (const [locale, expected] of [['de-DE', 'de'], ['fr-CA', 'fr'], ['es-419', 'es-ES'], ['zh-TW', 'zh-CN']]) assert.equal(resolveLanguage(locale), expected);
});

test('connection gaps and restarts preserve records without attributing unseen time to a player', t => {
  const f = fixture(t); let journal = new TurnJournal(f.path, f.now);
  journal.track('1', true); journal.observe('1', state('A', 1));
  f.advance(1000); journal.observe('1', state('A', 1));
  f.advance(1000); journal.suspend('1');
  assert.equal(journal.data.records[0].durationMs, 1000);
  assert.equal(journal.data.records[0].partial, true);
  f.advance(DAY); journal.observe('1', state('B', 7));
  f.advance(2000); journal.observe('1', state('B', 7));
  journal = new TurnJournal(f.path, f.now);
  assert.equal(journal.data.records[1].player, 'B');
  assert.equal(journal.data.records[1].durationMs, 2000);
  f.advance(DAY); journal.observe('1', state('C', 12));
  f.advance(3000); journal.observe('1', state(null, 13, true));
  assert.equal(journal.data.records[2].durationMs, 3000);
  assert.equal(journal.data.records[2].partial, true);
});
