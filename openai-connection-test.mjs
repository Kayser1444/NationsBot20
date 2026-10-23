import { questionModel } from './question-agent.mjs';
import { questionApiDiagnostics, safeDiagnostic } from './question-api-diagnostics.mjs';

const cooldownMs = 60000;
const timeoutMs = 20000;

async function readResult(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) throw new Error('Response too large.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { void reader.cancel().catch(() => {}); }
}

// Independent of question sources and subscriber quotas. Nothing runs on startup or GET.
export function createOpenAiConnectionTest({ env = process.env, fetcher = fetch, now = Date.now } = {}) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  let inFlight = null, lastResult = null, retryAt = 0;
  async function run() {
    const started = now(), signal = AbortSignal.timeout(timeoutMs);
    const finish = result => ({ configured: true, questionEnabled: env.NATIONS_QUESTION_ENABLED === '1',
      model: questionModel, checkedAt: new Date(started).toISOString(), durationMs: Math.max(0, now() - started),
      cached: false, ...result });
    let httpStatus, requestId;
    try {
      const response = await fetcher('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: questionModel, store: false, input: 'Reply with exactly OK.',
          reasoning: { effort: 'low' }, max_output_tokens: 512 }),
      });
      httpStatus = response.status;
      requestId = safeDiagnostic(response.headers.get('x-request-id'), 160, apiKey);
      if (!response.ok) {
        const diagnostics = await questionApiDiagnostics(response, apiKey);
        const message = httpStatus === 401 ? 'OpenAI nekade API-nyckeln.'
          : httpStatus === 403 ? 'OpenAI nekade åtkomst. Kontrollera nyckelns behörigheter och modellåtkomst.'
          : httpStatus === 404 ? 'Modellen eller API-resursen är inte tillgänglig för denna nyckel.'
          : httpStatus === 429 ? 'OpenAI avvisade anropet på grund av en kvot-, kredit- eller hastighetsgräns.'
          : 'OpenAI avvisade testanropet.';
        return finish({ ok: false, code: 'api_error', message, httpStatus, ...diagnostics });
      }
      const result = await readResult(response);
      const reply = Array.isArray(result.output) ? result.output.filter(item => item.type === 'message')
        .flatMap(item => Array.isArray(item.content) ? item.content : [])
        .filter(item => item.type === 'output_text').map(item => item.text).join('').trim() : '';
      const ok = result.status === 'completed' && reply === 'OK';
      return finish({ ok, httpStatus, requestId, code: ok ? 'ok' : 'unexpected_response',
        message: ok ? 'OpenAI-anslutningen fungerar. Modellen svarade på testanropet.'
          : 'OpenAI tog emot anropet men testsvaret blev ofullständigt eller oväntat.',
        inputTokens: Number.isSafeInteger(result.usage?.input_tokens) && result.usage.input_tokens >= 0 ? result.usage.input_tokens : null,
        outputTokens: Number.isSafeInteger(result.usage?.output_tokens) && result.usage.output_tokens >= 0 ? result.usage.output_tokens : null });
    } catch {
      return finish({ ok: false, httpStatus, requestId, code: signal.aborted ? 'timeout' : 'connection_error',
        message: signal.aborted ? 'OpenAI-testet nådde tidsgränsen på 20 sekunder.'
          : 'OpenAI kunde inte nås eller svaret kunde inte läsas.' });
    }
  }
  return async () => {
    if (!apiKey) return { configured: false, questionEnabled: env.NATIONS_QUESTION_ENABLED === '1',
      model: questionModel, ok: false, code: 'missing_key', message: 'OPENAI_API_KEY saknas. Administratörsnyckeln används inte för detta test.' };
    if (inFlight) return inFlight;
    if (now() < retryAt) return { ...lastResult, cached: true, retryAfterSeconds: Math.ceil((retryAt - now()) / 1000) };
    retryAt = now() + cooldownMs;
    inFlight = run();
    try { lastResult = await inFlight; return lastResult; }
    finally { inFlight = null; }
  };
}
