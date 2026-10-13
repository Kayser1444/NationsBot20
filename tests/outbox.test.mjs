import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outbox } from '../outbox.mjs';
import { sendDiscord, verifyDiscordDestination } from '../discord.mjs';

const destination = { guildId: 'guild', channelId: 'channel' };
const match = { id: '1', title: 'Game' };
const turn = player => ({ player, over: false });

test('shared turns deliver once per recipient, new followers do not replay receipts, and unsubscribe is isolated', async t => {
  const f = fixture(t); let box = f.open(); const delivered = [];
  box.observe(match, turn('Player'), ['a', 'b']);
  await box.flush({ validate: async () => true, send: async job => {
    if (job.userId === 'b') throw Object.assign(new Error('DM denied'), { retryable: false });
    delivered.push(job.userId);
  } });
  assert.deepEqual(delivered, ['a']);
  assert.equal(box.data.jobs[0].userId, 'b');
  box = f.open();
  box.updateSubscriptions({ Player: ['a', 'b'] }, { Player: ['a', 'b', 'c'] });
  box.observe(match, turn('Player'), ['a', 'b', 'c']);
  assert.deepEqual(box.data.jobs.map(job => job.userId), ['b', 'c']);
  box.updateSubscriptions({ Player: ['a', 'b', 'c'] }, { Player: ['a', 'c'] });
  await box.flush({ validate: async () => true, send: async job => delivered.push(job.userId) });
  assert.deepEqual(delivered, ['a', 'c']);
  box = f.open(); assert.equal(box.observe(match, turn('Player'), ['a', 'c']), false);
  box.observe(match, turn('Other'), []);
  box.observe(match, turn('Player'), ['a', 'c']);
  assert.equal(box.data.jobs.length, 2);
});

test('legacy confirmed turns and queued jobs upgrade without losing delivery history', async t => {
  const f = fixture(t); let box = f.open();
  box.data.turns['1'] = { player: 'Player', over: false, generation: 2, sent: true };
  box.save(); box = f.open();
  assert.equal(box.observe(match, turn('Player'), 'a'), false);
  box.updateSubscriptions({ Player: 'a' }, { Player: ['a', 'b'] });
  assert.equal(box.observe(match, turn('Player'), ['a', 'b']), true);
  assert.deepEqual(box.data.jobs.map(job => job.userId), ['b']);
  delete box.data.turns['1'].sentUsers; box.data.turns['1'].sent = false; box.save();
  box = f.open();
  await box.flush({ validate: async () => true, send: async () => {} });
  assert.ok(box.data.turns['1'].sentUsers.includes('b'));
});

test('unsubscribe cancels saved jobs; a changed recipient can receive the current turn', async t => {
  const f = fixture(t), box = f.open();
  box.observe(match, turn('Kayser'), 'old');
  box.updateSubscriptions({ Kayser: 'old' }, {});
  assert.equal(f.open().data.jobs.length, 0);
  box.updateSubscriptions({}, { Kayser: 'new' });
  box.observe(match, turn('Kayser'), 'new');
  await box.flush({ validate: async () => true, send: async job => assert.equal(job.userId, 'new') });
  assert.equal(box.data.turns['1'].sent, true);
  box.updateSubscriptions({ Kayser: 'new' }, { Kayser: 'newer' });
  assert.equal(box.observe(match, turn('Kayser'), 'newer'), true);
  assert.equal(f.open().data.jobs[0].userId, 'newer');
});
test('changing delivery preference retries only that user\'s blocked current reminder', async t => {
  const f = fixture(t), box = f.open();
  box.observe(match, turn('Kayser'), 'first');
  box.observe({ id: '2', title: 'Other game' }, turn('Other'), 'second');
  await box.flush({ validate: async () => true, send: async () => { throw Object.assign(new Error('DM blocked'), { retryable: false }); } });
  box.retryUser('first');
  assert.equal(box.data.jobs.find(job => job.userId === 'first').blocked, false);
  assert.equal(box.data.jobs.find(job => job.userId === 'second').blocked, true);
  let sent = 0;
  await box.flush({ validate: async () => true, send: async job => { assert.equal(job.userId, 'first'); sent++; } });
  assert.equal(sent, 1);
  box.retryUser('first');
  assert.equal(box.data.jobs.length, 1, 'already confirmed reminder is not requeued');
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nations-outbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'queue.json');
  let time = 1000;
  const now = () => time;
  return { path, now, advance: ms => { time += ms; }, open: () => new Outbox(path, destination, { now }) };
}

test('failed delivery survives restart, backs off, then records success without startup duplicates', async t => {
  const f = fixture(t); let box = f.open(); let sends = 0, validations = 0;
  box.observe(match, turn('Kayser'), '229311536827465728');
  const validate = async () => { validations++; return true; };
  await box.flush({ validate, send: async () => { sends++; throw new Error('Unavailable'); } });
  assert.equal(box.data.jobs.length, 1);
  assert.equal(box.data.jobs[0].nextAt, 61000);
  box = f.open();
  await box.flush({ validate, send: async () => { sends++; } });
  assert.equal(sends, 1);
  f.advance(60000);
  await box.flush({ validate, send: async () => { sends++; } });
  assert.equal(sends, 2); assert.equal(validations, 2);
  box = f.open();
  assert.equal(box.observe(match, turn('Kayser'), '229311536827465728'), false);
  assert.equal(box.data.jobs.length, 0);
  box.observe(match, turn('Other'));
  assert.equal(box.observe(match, turn('Kayser'), '229311536827465728'), true);
  assert.ok(!readFileSync(f.path, 'utf8').includes('webhook'));
});

test('fresh verification discards a turn that expired while the monitor was off', async t => {
  const f = fixture(t); let box = f.open();
  box.observe(match, turn('Kayser'), 'id'); box = f.open();
  await box.flush({ validate: async () => false, send: async () => assert.fail('must not send stale alert') });
  assert.equal(f.open().data.jobs.length, 0);
});

test('unreachable game retains the reminder and never sends from cached state', async t => {
  const f = fixture(t), box = f.open(); box.observe(match, turn('Kayser'), 'id');
  await box.flush({ validate: async () => { throw new Error('Game unavailable'); }, send: async () => assert.fail('must verify first') });
  assert.equal(f.open().data.jobs.length, 1);
});

test('turn changes or game completion remove queued reminders', async t => {
  const f = fixture(t), box = f.open();
  box.observe(match, turn('Kayser'), 'id');
  box.observe(match, turn('Other'));
  assert.equal(box.data.jobs.length, 0);
  box.observe(match, turn('Kayser'), 'id');
  box.observe(match, { player: null, over: true });
  assert.equal(f.open().data.jobs.length, 0);
});

test('state change during asynchronous verification prevents sending', async t => {
  const f = fixture(t), box = f.open(); box.observe(match, turn('Kayser'), 'id');
  await box.flush({ validate: async () => { box.observe(match, turn('Other')); return true; }, send: async () => assert.fail('turn changed') });
  assert.equal(box.data.jobs.length, 0);
});

test('permanent Discord errors block until restart; long rate limits are respected', async t => {
  const f = fixture(t), box = f.open(); box.observe(match, turn('Kayser'), 'id');
  await box.flush({ validate: async () => true, send: async () => { throw Object.assign(new Error('404'), { retryable: false }); } });
  assert.equal(box.data.jobs[0].blocked, true);
  await box.flush({ validate: async () => assert.fail('blocked'), send: async () => {} });
  const restarted = f.open(); assert.equal(restarted.data.jobs[0].blocked, false);
  f.advance(60000);
  await restarted.flush({ validate: async () => true, send: async () => { throw Object.assign(new Error('429'), { retryAfterMs: 600000 }); } });
  assert.equal(restarted.data.jobs[0].nextAt, f.now() + 600000);
});

test('a shutdown during verification leaves the reminder saved', async t => {
  const f = fixture(t), box = f.open(), controller = new AbortController();
  box.observe(match, turn('Kayser'), 'id');
  await box.flush({ signal: controller.signal, validate: async () => { controller.abort(); return true; }, send: async () => assert.fail('stopped') });
  assert.equal(f.open().data.jobs.length, 1);
});

test('Discord single-attempt transport classifies network, rate-limit and permanent failures', async () => {
  const url = new URL('https://discord.com/api/webhooks/123/test');
  await assert.rejects(sendDiscord(url, {}, { attempts: 1, fetcher: async () => { throw new Error('network'); } }), error => error.retryable === true);
  await assert.rejects(sendDiscord(url, {}, { attempts: 1, fetcher: async () => Response.json({ retry_after: 120 }, { status: 429 }) }), error => error.retryAfterMs === 120000);
  await assert.rejects(sendDiscord(url, {}, { attempts: 1, fetcher: async () => new Response('', { status: 404 }) }), error => error.retryable === false);
  await assert.rejects(verifyDiscordDestination(url, destination, { fetcher: async () => new Response('', { status: 503 }) }), error => error.retryable === true);
});
