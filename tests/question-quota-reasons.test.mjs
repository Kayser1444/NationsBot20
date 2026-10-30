import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuestionService } from '../question-service.mjs';

const userId = '229311536827465728';
const clock = Date.parse('2026-10-30T16:15:00Z'), day = '2026-10-30';
function fixture(t, { count = 0, elapsed = 60000, total = count, requests = 0, ledgerDay = day } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nations-quota-reasons-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'questions'); mkdirSync(root);
  const path = join(root, 'usage.json');
  writeFileSync(path, JSON.stringify({ day: ledgerDay, total, requests, users: { [userId]: { count, last: clock - elapsed } } }));
  let calls = 0;
  const service = createQuestionService({ directory, now: () => clock, env: { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only' },
    fetcher: async url => { if (url === 'https://api.openai.com/v1/responses') calls++; return new Response('', { status: 503 }); } });
  t.after(() => service.close());
  return { service, path, calls: () => calls };
}

const labels = {
  'sv-SE': ['Minutgränsen:', 'Din dygnskvot:', 'Gemensam dygnskvot:', 'Gemensam API-kvot:'],
  'en-US': ['Minute limit:', 'Your daily quota:', 'Shared daily question quota:', 'Shared daily API quota:'],
};
const scenarios = [
  { name: 'minute cooldown alone', count: 1, elapsed: 45000, blocked: [0], values: ['15 s'] },
  { name: 'personal day quota alone', count: 5, requests: 10, blocked: [1], values: ['5/5'] },
  { name: 'shared question quota alone', total: 20, requests: 40, blocked: [2], values: ['20/20'] },
  { name: 'shared API quota alone', total: 10, requests: 120, blocked: [3], values: ['120/120'] },
  { name: 'API reservation before full exhaustion', requests: 115, blocked: [3], values: ['115/120', '5', '6'] },
  { name: 'both shared quotas', total: 20, requests: 120, blocked: [2, 3], values: ['20/20', '120/120'] },
  { name: 'every blocking quota', count: 5, elapsed: 59999, total: 20, requests: 120, blocked: [0, 1, 2, 3], values: ['1 s', '5/5', '20/20', '120/120'] },
];
for (const [language, names] of Object.entries(labels)) for (const scenario of scenarios) {
  test(`${language} explains ${scenario.name} without acknowledging, spending or changing counters`, async t => {
    const f = fixture(t, scenario), before = readFileSync(f.path, 'utf8');
    const answer = await f.service.ask({ userId, question: 'Can I buy this advisor?', language, onAccepted: () => assert.fail('Quota rejection must not begin an investigation') });
    names.forEach((name, i) => assert.equal(answer.includes(name), scenario.blocked.includes(i), `Only an active limit should appear: ${name}`));
    for (const value of scenario.values) assert.ok(answer.includes(value), `${value} must appear in ${answer}`);
    assert.equal(answer.includes('00:00 UTC'), scenario.blocked.some(i => i !== 0));
    assert.ok(answer.length < 1800); assert.equal(f.calls(), 0); assert.equal(readFileSync(f.path, 'utf8'), before);
    if (scenario.requests === 115) assert.match(answer, language === 'sv-SE' ? /plats för upp till 6 anrop/ : /room for up to 6 requests/);
  });
}

test('exact minute and API reservation boundaries admit a question, and UTC rollover releases old counters', async t => {
  for (const scenario of [{ count: 1, elapsed: 60000 }, { requests: 114 }, { count: 5, elapsed: 0, total: 20, requests: 120, ledgerDay: '2026-10-29' }]) {
    const f = fixture(t, scenario); let accepted = 0;
    const answer = await f.service.ask({ userId, question: 'Can I buy this advisor?', onAccepted: () => { accepted++; } });
    assert.equal(accepted, 1); assert.equal(f.calls(), 1); assert.doesNotMatch(answer, /limit reached/);
    assert.equal(f.service.globalQuota().requests, scenario.ledgerDay ? 1 : (scenario.requests ?? 0) + 1);
  }
});
