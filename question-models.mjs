import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveQuestionJson } from './question-sources.mjs';
import { questionApiDiagnostics } from './question-api-diagnostics.mjs';

export const defaultQuestionModel = 'gpt-6.1-sol';
// Reviewed Responses/function-calling/structured-output compatibility. API discovery
// determines which of these IDs are listed for this service's own question key.
export const questionModels = Object.freeze([
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', input: 2, cached: 0.1, output: 10 },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', input: 1, cached: 0.05, output: 5 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', input: 0.1, cached: 0.01, output: 0.5 },
].map(Object.freeze));
export const questionPricingDate = '2026-10-30';
export const questionPricingUrl = 'https://developers.openai.com/api/docs/pricing';
export const supportedQuestionModel = id => questionModels.some(model => model.id === id);

export function createQuestionModels({ directory, env = process.env, fetcher = fetch, now = Date.now, report = () => {} } = {}) {
  const path = join(directory, 'model.json');
  let selection = { model: defaultQuestionModel }, selectionError = null, cached = null, inFlight = null;
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.schemaVersion !== 1 || !supportedQuestionModel(data.model)) throw new Error();
      selection = { model: data.model, updatedAt: data.updatedAt, updatedBy: data.updatedBy };
    } catch {
      selection = { model: null }; selectionError = 'Modellinställningen kunde inte läsas. Välj och spara en modell i ägarpanelen.';
      report(selectionError, 'error');
    }
  }
  async function discover() {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) return { available: false, error: 'OPENAI_API_KEY saknas.', models: [] };
    try {
      const response = await fetcher('https://api.openai.com/v1/models', { redirect: 'error',
        headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        const diagnostic = await questionApiDiagnostics(response, apiKey);
        return { available: false, models: [], httpStatus: response.status, ...diagnostic,
          error: response.status === 403 ? 'OpenAI nekade modellistan. Kontrollera API-nyckelns rättighet att läsa modeller.' : 'OpenAI:s modellista kunde inte hämtas.' };
      }
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      let size = 0; const chunks = [];
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
          if (size > 1024 * 1024) throw new Error(); chunks.push(Buffer.from(value)); }
      } finally { void reader.cancel().catch(() => {}); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data.data) || data.data.some(item => typeof item?.id !== 'string')) throw new Error();
      const ids = new Set(data.data.map(item => item.id));
      return { available: true, checkedAt: new Date(now()).toISOString(), models: questionModels.filter(model => ids.has(model.id)).map(({ id, name }) => ({ id, name })) };
    } catch { return { available: false, models: [], error: 'OpenAI:s modellista kunde inte hämtas. Tidigare modellval behålls.' }; }
  }
  async function catalogue() {
    // Cache successes and failures to bound dashboard polling and concurrent requests.
    if (!cached || now() >= cached.expiresAt) {
      if (!inFlight) inFlight = discover().then(result => { cached = { ...result, expiresAt: now() + 60000 }; return cached; }).finally(() => { inFlight = null; });
      await inFlight;
    }
    const { expiresAt, ...result } = cached;
    return structuredClone({ ...result, ...selection, selectionError });
  }
  return {
    catalogue,
    current() { if (selectionError) throw new Error(selectionError); return selection.model; },
    async select(model, actorId) {
      if (!supportedQuestionModel(model)) throw new Error('Modellen stöds inte av frågefunktionen.');
      const listed = await catalogue();
      if (!listed.available || !listed.models.some(item => item.id === model)) throw new Error('Modellen är inte tillgänglig i OpenAI:s senaste modellista för denna API-nyckel.');
      const next = { schemaVersion: 1, model, updatedAt: new Date(now()).toISOString(), updatedBy: /^\d{17,20}$/.test(actorId) ? actorId : null };
      saveQuestionJson(path, next); selection = { model: next.model, updatedAt: next.updatedAt, updatedBy: next.updatedBy }; selectionError = null;
      report(`Frågemodell ändrad till ${model} av ${next.updatedBy ?? 'lokal administratör'}. Gäller nya frågor.`);
      return catalogue();
    },
  };
}

const count = value => Number.isSafeInteger(value) && value >= 0;
export function questionUsage(result, model) {
  const usage = result?.usage, details = usage?.input_tokens_details;
  const fields = { serviceTier: typeof result?.service_tier === 'string' ? result.service_tier : 'unknown', pricingDate: questionPricingDate };
  for (const [name, value] of Object.entries({ inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens,
    cachedInputTokens: details?.cached_tokens, cacheWriteTokens: details?.cache_write_tokens,
    cacheWrite30mTokens: details?.cache_write_tokens_details?.ttl_30m_tokens, cacheWrite12hTokens: details?.cache_write_tokens_details?.ttl_12h_tokens,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens })) if (count(value)) fields[name] = value;
  const rates = questionModels.find(item => item.id === model);
  // Unknown cache details/tier must not turn into a fictitious zero or precise bill.
  if (!rates || (typeof result?.model === 'string' && result.model !== model && !result.model.startsWith(model + '-')) ||
      fields.serviceTier !== 'default' || !count(fields.inputTokens) || !count(fields.outputTokens) ||
      !count(fields.cachedInputTokens) || !count(fields.cacheWriteTokens) || fields.inputTokens > 272000) return fields;
  const write30 = fields.cacheWriteTokens === 0 ? 0 : fields.cacheWrite30mTokens;
  const write12 = fields.cacheWriteTokens === 0 ? 0 : fields.cacheWrite12hTokens;
  if (!count(write30) || !count(write12) || write30 + write12 !== fields.cacheWriteTokens || fields.cachedInputTokens + fields.cacheWriteTokens > fields.inputTokens) return fields;
  fields.estimatedCostUsd = ((fields.inputTokens - fields.cachedInputTokens - fields.cacheWriteTokens) * rates.input +
    fields.cachedInputTokens * rates.cached + write30 * rates.input * 1.25 + write12 * rates.input * 2.5 + fields.outputTokens * rates.output) / 1000000;
  return fields;
}
