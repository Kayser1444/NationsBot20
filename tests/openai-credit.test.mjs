import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiCredit } from '../openai-credit.mjs';

const env = { NATIONS_OPENAI_ADMIN_KEY: 'synthetic-admin-secret', NATIONS_OPENAI_CREDIT_TOTAL_USD: '5', NATIONS_OPENAI_CREDIT_START_DATE: '2026-10-15' };
const timestamp = Date.parse('2026-10-18T10:00:00Z');
const startTime = Date.parse('2026-10-15T00:00:00Z') / 1000;
const cost = value => ({ object: 'organization.costs.result', amount: { value, currency: 'usd' } });
const bucket = (day, results) => ({ object: 'bucket', start_time: startTime + day * 86400, end_time: startTime + (day + 1) * 86400, results });
const page = (data, next = null) => ({ object: 'page', data, has_more: next !== null, next_page: next });

test('OpenAI credit requires a separate admin key, valid initial amount and explicit start date; never uses the question key or monthly budget', async () => {
  for (const settings of [
    {}, { ...env, NATIONS_OPENAI_ADMIN_KEY: '', OPENAI_API_KEY: 'question-secret' },
    { ...env, NATIONS_OPENAI_CREDIT_START_DATE: '' }, { ...env, NATIONS_OPENAI_CREDIT_START_DATE: '2026-02-30' },
    { ...env, NATIONS_OPENAI_CREDIT_START_DATE: '2027-01-01' },
    { ...env, NATIONS_OPENAI_CREDIT_TOTAL_USD: '', NATIONS_OPENAI_MONTHLY_BUDGET_USD: '5' },
    { ...env, NATIONS_OPENAI_CREDIT_TOTAL_USD: '-1' }, { ...env, NATIONS_OPENAI_CREDIT_TOTAL_USD: '5.001' },
  ]) {
    const read = createOpenAiCredit({ env: settings, now: () => timestamp, fetcher: () => assert.fail('Unexpected request') });
    const result = await read();
    assert.equal(result.configured, false); assert.equal(result.available, false);
    assert.equal(result.updatedAt, null);
  }
});

test('credit subtracts all organization costs across every page without rounding individual charges or applying a project filter', async () => {
  const seen = [];
  const read = createOpenAiCredit({ env: { ...env, NATIONS_OPENAI_PROJECT_ID: 'ignored-project' }, now: () => timestamp, fetcher: async (url, options) => {
    seen.push(url);
    assert.equal(url.origin + url.pathname, 'https://api.openai.com/v1/organization/costs');
    assert.equal(url.searchParams.get('start_time'), String(startTime));
    assert.equal(url.searchParams.get('end_time'), String(timestamp / 1000));
    assert.equal(url.searchParams.get('limit'), '180');
    assert.equal(url.searchParams.has('project_ids'), false);
    assert.equal(url.searchParams.get('bucket_width'), '1d');
    assert.equal(options.headers.authorization, 'Bearer ' + env.NATIONS_OPENAI_ADMIN_KEY);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return Response.json(seen.length === 1 ? page([bucket(0, [cost(0.1), cost(0.004)])], 'next-page') : page([bucket(1, [cost(0.196)])]));
  } });
  const result = await read();
  assert.equal(seen.length, 2); assert.equal(seen[1].searchParams.get('page'), 'next-page');
  assert.ok(Math.abs(result.spentUsd - 0.3) < 1e-10);
  assert.ok(Math.abs(result.remainingCreditUsd - 4.7) < 1e-10);
  assert.equal(result.fundedUsd, 5); assert.equal(result.startDate, '2026-10-15');
  assert.equal(result.stale, false); assert.equal(result.updatedAt, new Date(timestamp).toISOString());
  assert.equal(JSON.stringify(result).includes(env.NATIONS_OPENAI_ADMIN_KEY), false);
});

test('credit is shared across concurrent requests, cached for 15 minutes and never reset on a new month', async () => {
  let clock = timestamp, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const read = createOpenAiCredit({ env, now: () => clock, fetcher: async url => {
    calls++; assert.equal(url.searchParams.get('start_time'), String(startTime));
    await gate; return Response.json(page([bucket(0, [cost(0.3)])]));
  } });
  const first = read(), second = read(); assert.equal(calls, 1); release();
  assert.deepEqual(await first, await second);
  clock += 899999; await read(); assert.equal(calls, 1);
  clock++; await read(); assert.equal(calls, 2);
  clock = Date.parse('2026-11-01T12:00:00Z');
  assert.equal((await read()).remainingCreditUsd, 4.7); assert.equal(calls, 3);
});

test('an incomplete or failed refresh retains the last full estimate, hides secrets and backs off before recovery', async () => {
  let clock = timestamp, calls = 0, fail = false;
  const read = createOpenAiCredit({ env, now: () => clock, fetcher: async url => {
    calls++;
    if (fail && url.searchParams.has('page')) throw new Error(env.NATIONS_OPENAI_ADMIN_KEY);
    return Response.json(fail ? page([bucket(0, [cost(1)])], 'failing-page') : page([bucket(0, [cost(0.3)])]));
  } });
  const first = await read(); clock += 900000; fail = true;
  const stale = await read();
  assert.equal(stale.available, true); assert.equal(stale.stale, true);
  assert.equal(stale.remainingCreditUsd, first.remainingCreditUsd);
  assert.equal(stale.updatedAt, first.updatedAt);
  assert.equal(JSON.stringify(stale).includes(env.NATIONS_OPENAI_ADMIN_KEY), false);
  clock++; await read(); assert.equal(calls, 3);
  clock += 900000; fail = false;
  const recovered = await read(); assert.equal(recovered.stale, false); assert.equal(recovered.error, null);
});

test('HTTP, JSON, currency, amount, missing-page and repeated-page failures cannot produce a misleading estimate', async () => {
  const responses = [
    () => new Response('unauthorized ' + env.NATIONS_OPENAI_ADMIN_KEY, { status: 401 }),
    () => new Response('rate limited', { status: 429 }), () => new Response('invalid JSON'),
    () => Response.json({ object: 'page', data: [] }),
    () => Response.json(page([bucket(0, [{ ...cost(0.3), amount: { value: 0.3, currency: 'eur' } }])])),
    () => Response.json(page([bucket(0, [cost(null)])])),
    () => Response.json(page([bucket(0, [cost('0.3')])])),
    () => Response.json({ ...page([]), has_more: true, next_page: null }),
    () => Response.json(page([], 'same-cursor')),
    () => Response.json(page([bucket(0, [cost(0.3)])], 'same-cursor')),
  ];
  for (const response of responses) {
    let calls = 0;
    const read = createOpenAiCredit({ env, now: () => timestamp, fetcher: async () => { calls++; return response(); } });
    const result = await read();
    assert.equal(result.available, false); assert.equal(result.updatedAt, null);
    assert.ok(result.error); assert.equal(JSON.stringify(result).includes(env.NATIONS_OPENAI_ADMIN_KEY), false);
    const attempted = calls; await read(); assert.equal(calls, attempted);
  }
});

test('a new top-up increases cumulative credit without changing the cost baseline; exhausted credit stays zero', async () => {
  for (const [funded, spent, remaining] of [['10', 0.3, 9.7], ['5', 5.2, 0], ['0', 0, 0]]) {
    const read = createOpenAiCredit({ env: { ...env, NATIONS_OPENAI_CREDIT_TOTAL_USD: funded }, now: () => timestamp,
      fetcher: async () => Response.json(page([bucket(0, [cost(spent)])])) });
    const result = await read(); assert.equal(result.available, true); assert.equal(result.remainingCreditUsd, remaining);
    assert.equal(result.startDate, env.NATIONS_OPENAI_CREDIT_START_DATE);
  }
  const noCosts = createOpenAiCredit({ env, now: () => timestamp, fetcher: async () => Response.json(page([])) });
  assert.equal((await noCosts()).remainingCreditUsd, 5);
});

test('a baseline older than the supported history window cannot silently overstate the remaining credit', async () => {
  const read = createOpenAiCredit({ env, now: () => Date.parse('2027-10-16T00:00:00Z'), fetcher: () => assert.fail('History is too old') });
  assert.equal((await read()).available, false);
});
