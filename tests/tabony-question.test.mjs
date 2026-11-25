import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createQuestionService } from '../question-service.mjs';
import { startTabonyQuestionServer } from '../tabony-question-server.mjs';

test('the private Tabony route uses the shared investigation and never needs a Discord user ID', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tabony-question-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'a'.repeat(64);
  const question = 'Who has the most Military?';
  const matchContext = { asker: 'Kayser', bot: 'NationsBot20', decision: 5, players: {
    Kayser: { resources: { '[Military]': 8 } },
    NationsBot20: { resources: { '[Military]': 4 } },
  } };
  const line = 'You have the most Military with 8.';
  let calls = 0;
  const service = createQuestionService({ directory,
    env: { NATIONS_QUESTION_ENABLED: '1', NATIONS_TABONY_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'test-only' },
    fetcher: async (url, options) => {
      if (url !== 'https://api.openai.com/v1/responses') return new Response('', { status: 503 });
      calls++;
      const body = JSON.parse(options.body);
      assert.deepEqual(JSON.parse(body.input[0].content), { question, publicMatchSnapshot: matchContext });
      assert.match(body.instructions, /one plain-text sentence/);
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ question_language: 'en', answer_language: 'en', english_question: null,
          parts: [{ text: line, english_text: null }] }),
      }] }] });
    },
  });
  t.after(() => service.close());
  const server = await startTabonyQuestionServer({ ask: service.askTabony, token, port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/question`;
  const ask = (asker, bearer = token) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ asker, question, matchContext: { ...matchContext, asker } }),
  });
  assert.equal((await ask('Kayser', 'wrong')).status, 401);
  assert.equal((await ask('Spectator')).status, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await (await ask('Kayser')).json(), { reply: line });
  assert.equal(service.globalQuota().total, 1);
  assert.match((await (await ask('Kayser')).json()).reply, /question limit/);
  assert.equal(calls, 1);
});
