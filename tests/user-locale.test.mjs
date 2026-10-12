import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveUserLocale, readUserLocale, saveDmPreference, saveSubscriptions } from '../subscriptions.mjs';
import { handleSubscriptionCommand } from '../discord-commands.mjs';

test('observed locales survive preference edits and only update the invoking user', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nations-locale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'friends.json');
  const first = '111111111111111111', second = '222222222222222222';
  writeFileSync(path, JSON.stringify({ subscriptions: { Player: first }, matches: [], discord: {} }));
  assert.equal(readUserLocale(path, first), null);
  assert.equal(saveUserLocale(path, first, 'sv-SE'), true);
  assert.equal(saveUserLocale(path, second, 'en-US'), true);
  const before = readFileSync(path, 'utf8');
  assert.equal(saveUserLocale(path, first, 'sv-SE'), false);
  assert.equal(saveUserLocale(path, first, undefined), false);
  assert.equal(saveUserLocale(path, first, '@everyone'), false);
  assert.equal(readFileSync(path, 'utf8'), before);
  saveDmPreference(path, first, true);
  saveSubscriptions(path, {});
  assert.equal(readUserLocale(path, first), 'sv-SE');
  assert.equal(readUserLocale(path, second), 'en-US');
  saveUserLocale(path, first, 'en-GB');
  assert.equal(readUserLocale(path, first), 'en-GB');
  assert.equal(JSON.parse(readFileSync(path)).dmPreferences[first], true);
});

test('status shows the observed Discord language even without a subscription', () => {
  for (const locale of ['sv-SE', 'en-US', 'en-GB', null]) {
    const content = handleSubscriptionCommand({ command: 'status', userId: '111111111111111111' }, {
      getSubscriptions: () => ({}), getStatus: () => ({}), getLocale: () => locale,
    });
    assert.match(content, /Discord-språk:|Discord language:/);
    assert.ok(locale ? content.includes('`' + locale + '`') : content.includes('not detected'));
    assert.match(content, /Botens språk:|Bot language:/);
  }
});
