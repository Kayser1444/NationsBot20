import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiConnectionTest } from '../openai-connection-test.mjs';

const env = { OPENAI_API_KEY: 'synthetic-question-secret', NATIONS_OPENAI_ADMIN_KEY: 'unused-admin-secret', NATIONS_QUESTION_ENABLED: '1' };
const completed = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
  usage: { input_tokens: 12, output_tokens: 3 } }, { headers: { 'x-request-id': 'req_test' } });

test('connection test uses the question key and model for one tiny Responses request, only when invoked', async () => {
  let clock = Date.parse('2026-10-23T12:00:00Z'), calls = 0;
  const run = createOpenAiConnectionTest({ env, now: () => clock, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer ' + env.OPENAI_API_KEY);
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { model: 'gpt-6.1-sol', store: false, input: 'Reply with exactly OK.',
      reasoning: { effort: 'low' }, max_output_tokens: 512 });
    clock += 75;
    return completed();
  } });
  assert.equal(calls, 0);
  const result = await run();
  assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(result.httpStatus, 200);
  assert.equal(result.requestId, 'req_test'); assert.equal(result.durationMs, 75);
  assert.equal(result.checkedAt, '2026-10-23T12:00:00.000Z');
  assert.equal(result.inputTokens, 12); assert.equal(result.outputTokens, 3);
  assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false);
});

test('missing question key never falls back to the admin key, and disabled questions are reported independently', async () => {
  const missing = await createOpenAiConnectionTest({ env: { NATIONS_OPENAI_ADMIN_KEY: env.NATIONS_OPENAI_ADMIN_KEY },
    fetcher: () => assert.fail('No key must not call OpenAI') })();
  assert.equal(missing.configured, false); assert.equal(missing.ok, false); assert.equal(missing.code, 'missing_key');
  const disabled = await createOpenAiConnectionTest({ env: { OPENAI_API_KEY: env.OPENAI_API_KEY }, fetcher: async () => completed() })();
  assert.equal(disabled.ok, true); assert.equal(disabled.questionEnabled, false);
});

test('concurrent clicks share one request and success and failure both back off for a minute', async () => {
  for (const fail of [false, true]) {
    let clock = 1000, calls = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const run = createOpenAiConnectionTest({ env, now: () => clock, fetcher: async () => {
      calls++; await gate;
      return fail ? new Response('', { status: 401 }) : completed();
    } });
    const first = run(), second = run(); assert.equal(calls, 1); release();
    assert.deepEqual(await first, await second);
    const cached = await run(); assert.equal(cached.cached, true); assert.equal(cached.retryAfterSeconds, 60);
    assert.equal(calls, 1); assert.equal(cached.ok, !fail);
    clock += 59999; await run(); assert.equal(calls, 1);
    clock++; await run(); assert.equal(calls, 2);
  }
});

test('API rejections retain sanitized status, code and request ID, never credentials or arbitrary payloads', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let calls = 0;
    const result = await createOpenAiConnectionTest({ env, fetcher: async () => {
      calls++;
      return Response.json({ error: { code: 'permission_denied', type: 'permission_error',
        message: `Denied ${env.OPENAI_API_KEY} Bearer unrelated-secret sk-proj-othersecret`, private: 'private-payload' } },
      { status, headers: { 'x-request-id': 'req_rejected' } });
    } })();
    assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.httpStatus, status);
    assert.equal(result.errorCode, 'permission_denied'); assert.equal(result.requestId, 'req_rejected');
    for (const secret of [env.OPENAI_API_KEY, 'unrelated-secret', 'sk-proj-othersecret', 'private-payload']) {
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
  }
});

test('network errors, invalid JSON, oversized output and incomplete or wrong responses never pass', async () => {
  for (const fetcher of [
    async () => { throw new Error(env.OPENAI_API_KEY); },
    async () => new Response('<html>Proxy error</html>'),
    async () => new Response('x'.repeat(32769)),
    async () => Response.json({ status: 'incomplete', output: [] }),
    async () => Response.json({ status: 'completed', output: [] }),
    async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'wrong' }] }] }),
  ]) {
    const result = await createOpenAiConnectionTest({ env, fetcher })();
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY), false);
  }
});

test('a timed out request is aborted, reported safely and never retried', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  // AbortSignal.timeout uses a real timer; replace it here to exercise the same signal seam immediately.
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 20000); return controller.signal;
  });
  let calls = 0;
  const run = createOpenAiConnectionTest({ env, fetcher: async (_url, { signal }) => {
    calls++; assert.equal(signal, controller.signal);
    controller.abort(); throw new DOMException('Timed out', 'TimeoutError');
  } });
  const result = await run();
  assert.equal(result.code, 'timeout'); assert.equal(result.ok, false);
  await run(); assert.equal(calls, 1);
});
