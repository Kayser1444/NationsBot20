import test from 'node:test';
import assert from 'node:assert/strict';
import { botDelivery } from '../bot-delivery.mjs';
import { turnMessage } from '../discord.mjs';
import { serviceStatusMessage } from '../service-status.mjs';
const expected = { guildId: '706912380067643473', channelId: '1558878151646388264' };
const userId = '229311536827465728';
const dmId = '1559000000000000001';
test('DM reminder goes only to the intended private channel; off goes only to the public channel', async () => {
  const requests = [];
  const transport = botDelivery('secret', expected, { fetcher: async (url, options) => {
    requests.push(url);
    if (url.endsWith('/users/@me/channels')) {
      assert.equal(JSON.parse(options.body).recipient_id, userId);
      return Response.json({ id: dmId, type: 1, recipients: [{ id: userId }] });
    }
    const channelId = url.includes(dmId) ? dmId : expected.channelId;
    return Response.json({ id: 'message', channel_id: channelId, mentions: [{ id: userId }] });
  } });
  const payload = turnMessage('Kayser', { id: '1' }, userId);
  await transport.sendReminder(payload, userId, () => true);
  assert.deepEqual(requests, ['https://discord.com/api/v10/users/@me/channels', `https://discord.com/api/v10/channels/${dmId}/messages`]);
  requests.length = 0;
  await transport.sendReminder(payload, userId, () => false);
  assert.deepEqual(requests, [`https://discord.com/api/v10/channels/${expected.channelId}/messages`]);
});
test('blocked DM, wrong recipient, or changed delivery mode never falls back to a public message', async () => {
  for (const scenario of ['blocked', 'wrong-recipient', 'changed-mode', 'turn-expired']) {
    const requests = []; let enabled = true;
    const transport = botDelivery('secret', expected, { fetcher: async (url) => {
      requests.push(url);
      if (scenario === 'changed-mode') enabled = false;
      if (scenario === 'blocked') return Response.json({ code: 50007 }, { status: 403 });
      return Response.json({ id: dmId, type: 1, recipients: [{ id: scenario === 'wrong-recipient' ? 'other' : userId }] });
    } });
    await assert.rejects(transport.sendReminder({ content: 'test' }, userId, () => enabled, undefined, () => scenario !== 'turn-expired'));
    assert.equal(requests.length, 1); assert.ok(!requests[0].includes(expected.channelId));
  }
});
test('forced private control message stops when DM is disabled during channel creation', async () => {
  const requests = []; let enabled = true;
  const transport = botDelivery('secret', expected, { fetcher: async url => {
    requests.push(url); enabled = false;
    return Response.json({ id: dmId, type: 1, recipients: [{ id: userId }] });
  } });
  await assert.rejects(transport.sendReminder({ content: 'control', allowed_mentions: { parse: [] } }, userId, () => true, undefined, () => enabled));
  assert.deepEqual(requests, ['https://discord.com/api/v10/users/@me/channels']);
});

test('bot sends messages as itself, preserving only the intended mention and silent statuses', async () => {
  const requests = [];
  const transport = botDelivery('secret', expected, { fetcher: async (url, options) => {
    requests.push({ url, options });
    return Response.json(options.method === 'GET' ? { id: expected.channelId, guild_id: expected.guildId, type: 0 }
      : { id: 'message', channel_id: expected.channelId, mentions: [{ id: userId }] });
  } });
  await transport.verify();
  const receipt = await transport.send(turnMessage('Kayser', { id: '3038', title: 'S11-1A-P2' }, userId));
  await transport.send(serviceStatusMessage(true)); await transport.send(serviceStatusMessage(false));
  assert.deepEqual(receipt.mentionedUserIds, [userId]);
  const turn = JSON.parse(requests[1].options.body);
  assert.equal(Object.hasOwn(turn, 'username'), false);
  assert.deepEqual(turn.allowed_mentions, { parse: [], users: [userId] });
  assert.match(turn.content, /Din tur i/);
  for (const request of requests) {
    assert.equal(request.options.headers.authorization, 'Bot secret');
    assert.ok(!request.url.includes('/webhooks/'));
  }
  for (const request of requests.slice(2)) assert.deepEqual(JSON.parse(request.options.body).allowed_mentions, { parse: [], users: [], roles: [] });
});
test('wrong guild, missing permissions, transient errors and rate limits retain their delivery semantics', async () => {
  const wrong = botDelivery('secret', expected, { fetcher: async () => Response.json({ id: expected.channelId, guild_id: 'wrong', type: 0 }) });
  await assert.rejects(wrong.verify(), error => error.retryable === false);
  for (const status of [401, 403, 404, 500, 429]) {
    const transport = botDelivery('secret', expected, { fetcher: async () => Response.json({ retry_after: 120 }, { status }) });
    await assert.rejects(transport.verify(), error => error.retryable === (status >= 500 || status === 429) && !error.message.includes('secret'));
    if (status === 429) await assert.rejects(transport.send({ content: 'test' }), error => error.retryAfterMs === 120000);
  }
  const network = botDelivery('secret', expected, { fetcher: async () => { throw new Error('secret'); } });
  await assert.rejects(network.send({ content: 'test' }), error => error.retryable && !error.message.includes('secret'));
});
test('Discord Missing Access explains the channel permission needed without revealing the token', async () => {
  const transport = botDelivery('secret', expected, { fetcher: async () => Response.json({ code: 50001, message: 'Missing Access' }, { status: 403 }) });
  await assert.rejects(transport.verify(), error => error.message.includes('Visa kanal') && error.message.includes('50001') && !error.message.includes('secret'));
});
