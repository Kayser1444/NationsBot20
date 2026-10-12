import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceStatus, serviceStatusMessage } from '../service-status.mjs';
import { DiscordDeliveryError } from '../discord.mjs';

test('start and repeated stop calls each deliver one unmentioned status', async () => {
  const posts = [];
  const status = new ServiceStatus(async payload => posts.push(payload));
  await status.start(); await status.start();
  await Promise.all([status.stop(), status.stop()]);
  assert.deepEqual(posts, [serviceStatusMessage(true), serviceStatusMessage(false)]);
  for (const post of posts) assert.deepEqual(post.allowed_mentions, { parse: [], users: [], roles: [] });
});

test('stopping cancels an unfinished startup before sending shutdown', async () => {
  const posts = [];
  const status = new ServiceStatus(async (payload, signal) => {
    if (payload.content.includes('startat')) {
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    }
    posts.push(payload);
  });
  void status.start();
  await status.stop();
  assert.deepEqual(posts, [serviceStatusMessage(false)]);
});

test('Discord status failures are reported and do not prevent stopping', async () => {
  const reports = [];
  const status = new ServiceStatus(async () => { throw new Error('offline'); }, message => reports.push(message));
  await status.start(); await status.stop();
  assert.equal(reports.length, 2);
});
test('status failures include safe delivery diagnostics but never arbitrary exception details', async () => {
  const reports = [];
  const status = new ServiceStatus(async () => { throw new DiscordDeliveryError('Visa kanal behövs (50001).', { retryable: false }); }, message => reports.push(message));
  await status.start(); await status.stop();
  assert.ok(reports.every(message => message.includes('50001')));
  const unsafe = new ServiceStatus(async () => { throw new Error('private-token'); }, message => reports.push(message));
  await unsafe.start(); assert.ok(!reports.at(-1).includes('private-token'));
});
