import test from 'node:test';
import assert from 'node:assert/strict';
import { createRailwayBilling } from '../railway-billing.mjs';

const env = { NATIONS_RAILWAY_API_TOKEN: 'synthetic-private-token', NATIONS_RAILWAY_WORKSPACE_ID: 'workspace-id' };
const customer = { isTrialing: true, trialDaysRemaining: 25, remainingUsageCreditBalance: 4.66 };
const success = (value = customer) => Response.json({ data: { workspace: { customer: value } } });

test('billing stays inactive without complete configuration and does not contact Railway', async () => {
  for (const settings of [{}, { NATIONS_RAILWAY_API_TOKEN: env.NATIONS_RAILWAY_API_TOKEN }, { NATIONS_RAILWAY_WORKSPACE_ID: 'workspace-id' }]) {
    const billing = createRailwayBilling({ env: settings, fetcher: () => { assert.fail('Unexpected API call'); } });
    const result = await billing();
    assert.equal(result.configured, false); assert.equal(result.available, false);
    assert.equal(result.updatedAt, null);
    assert.equal(JSON.stringify(result).includes(env.NATIONS_RAILWAY_API_TOKEN), false);
  }
});

test('billing queries only the configured workspace and shares a 15 minute cache across concurrent readers', async () => {
  let clock = 0, calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const billing = createRailwayBilling({ env, now: () => clock, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://backboard.railway.com/graphql/v2');
    assert.equal(options.headers.authorization, 'Bearer ' + env.NATIONS_RAILWAY_API_TOKEN);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.variables, { workspaceId: 'workspace-id' });
    assert.match(body.query, /^query /);
    await pending;
    return success();
  } });
  const first = billing(), second = billing();
  assert.equal(calls, 1); release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(a.remainingCreditUsd, 4.66); assert.equal(a.trialDaysRemaining, 25);
  assert.equal(a.isTrialing, true); assert.equal(a.stale, false);
  assert.equal(a.updatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(JSON.stringify(a).includes(env.NATIONS_RAILWAY_API_TOKEN), false);
  clock = 899999; await billing(); assert.equal(calls, 1);
  clock = 900000; await billing(); assert.equal(calls, 2);
});

test('failed refresh preserves the last balance and timestamp, redacts errors and backs off before recovery', async () => {
  let clock = 0, fail = false, calls = 0;
  const billing = createRailwayBilling({ env, now: () => clock, fetcher: async () => {
    calls++;
    if (fail) throw new Error('Internal error with ' + env.NATIONS_RAILWAY_API_TOKEN);
    return success({ ...customer, remainingUsageCreditBalance: calls === 1 ? 4.66 : 3.5 });
  } });
  const first = await billing();
  clock = 900000; fail = true;
  const stale = await billing();
  assert.equal(stale.available, true); assert.equal(stale.stale, true);
  assert.equal(stale.remainingCreditUsd, 4.66); assert.equal(stale.updatedAt, first.updatedAt);
  assert.equal(JSON.stringify(stale).includes(env.NATIONS_RAILWAY_API_TOKEN), false);
  clock++; await billing(); assert.equal(calls, 2);
  clock = 1800000; fail = false;
  const recovered = await billing();
  assert.equal(recovered.stale, false); assert.equal(recovered.error, null);
  assert.equal(recovered.remainingCreditUsd, 3.5); assert.notEqual(recovered.updatedAt, first.updatedAt);
});

test('HTTP failures, GraphQL partial errors, malformed JSON and invalid billing values remain unavailable', async () => {
  const responses = [
    () => new Response('unauthorized', { status: 401 }),
    () => new Response('rate limited', { status: 429 }),
    () => Response.json({ errors: [{ message: env.NATIONS_RAILWAY_API_TOKEN }], data: { workspace: { customer } } }),
    () => new Response('not JSON'),
    () => Response.json({ data: { workspace: null } }),
    () => success({ ...customer, remainingUsageCreditBalance: null }),
    () => success({ ...customer, remainingUsageCreditBalance: '4.66' }),
    () => success({ ...customer, trialDaysRemaining: null }),
    () => success({ ...customer, isTrialing: null }),
  ];
  for (const response of responses) {
    let calls = 0;
    const billing = createRailwayBilling({ env, now: () => 0, fetcher: async () => { calls++; return response(); } });
    const result = await billing();
    assert.equal(result.configured, true); assert.equal(result.available, false);
    assert.equal(result.updatedAt, null); assert.ok(result.error);
    assert.equal(JSON.stringify(result).includes(env.NATIONS_RAILWAY_API_TOKEN), false);
    await billing(); assert.equal(calls, 1);
  }
});

test('zero credit and a paid account are valid and a negative remaining credit is displayed as exhausted', async () => {
  for (const remainingUsageCreditBalance of [0, -0.1]) {
    const billing = createRailwayBilling({ env, fetcher: async () => success({ isTrialing: false, trialDaysRemaining: 0, remainingUsageCreditBalance }) });
    const result = await billing();
    assert.equal(result.available, true); assert.equal(result.isTrialing, false);
    assert.equal(result.remainingCreditUsd, 0);
  }
});
