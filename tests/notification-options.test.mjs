import test from 'node:test';
import assert from 'node:assert/strict';
import { commands, handleSubscriptionCommand } from '../discord-commands.mjs';
test('notifications owns optional DM selection; SM table has only div; standalone DM command is removed', () => {
  assert.equal(commands.some(c => c.name === 'dm'), false);
  assert.deepEqual(commands.find(c => c.name === 'smtable').options.map(o => o.name), ['div']);
  const option = commands.find(c => c.name === 'notifications').options.find(o => o.name === 'on').options.find(o => o.name === 'dm');
  assert.deepEqual(option.choices.map(c => c.value), ['on', 'off']); assert.equal(option.required, false);
});
test('notification delivery is on by default, explicit off persists, omitted choices preserve it; invalid claims do not change preferences', () => {
  let subscriptions = {}, dm, enabled = 0;
  const service = { getSubscriptions: () => subscriptions, getNames: () => ['Kayser'], commit: next => { subscriptions = next; },
    getDm: () => dm ?? true, setDm: (_, value) => { dm = value; }, getLocale: () => 'sv-SE', onNotificationsEnabled: () => { enabled++; } };
  const run = options => handleSubscriptionCommand({ command: 'notifications', action: 'on', userId: '229311536827465728', displayName: 'Kayser', ...options }, service);
  assert.match(run({}), /endast som DM/); assert.equal(enabled, 1);
  assert.match(run({ dm: 'off' }), /DM av/); assert.equal(dm, false);
  assert.match(run({}), /DM av/); assert.equal(dm, false);
  assert.match(run({ dm: 'on', nationsName: 'Different' }), /Avsluta först/); assert.equal(dm, false); assert.equal(enabled, 3);
  assert.match(run({ dm: 'on' }), /endast DM/); assert.equal(dm, true);
  run({ action: 'off' }); assert.deepEqual(subscriptions, {}); assert.equal(dm, true);
});
