const endpoint = 'https://api.openai.com/v1/organization/costs';
const cacheMs = 15 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

export function createOpenAiCredit({ env = process.env, fetcher = fetch, now = Date.now } = {}) {
  const token = env.NATIONS_OPENAI_ADMIN_KEY?.trim();
  const startDate = env.NATIONS_OPENAI_CREDIT_START_DATE?.trim();
  const startMs = /^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '') ? Date.parse(startDate + 'T00:00:00Z') : NaN;
  const amount = env.NATIONS_OPENAI_CREDIT_TOTAL_USD?.trim() ?? '';
  const fundedUsd = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount) ? Number(amount) : NaN;
  const configured = Boolean(token && Number.isFinite(startMs) && new Date(startMs).toISOString().slice(0, 10) === startDate
    && startMs <= now() && Number.isFinite(fundedUsd));
  let cached = null, retryAt = 0, inFlight = null, failed = false;
  const snapshot = () => ({
    configured, available: cached !== null, stale: cached !== null && failed, updatedAt: null, ...cached,
    error: !configured ? 'OpenAI-information är inte aktiverad.'
      : failed ? 'OpenAI-informationen kunde inte hämtas. Ett nytt försök görs senare.' : null,
  });
  async function refresh() {
    try {
      const fetchedAt = now();
      // Do not silently overstate credit if the beginning drops out of available history.
      if (fetchedAt - startMs > 365 * dayMs) throw new Error();
      const endTime = Math.floor(fetchedAt / 1000);
      const signal = AbortSignal.timeout(8000), cursors = new Set(), buckets = new Set();
      let spentUsd = 0, cursor = null, complete = false;
      for (let page = 0; page < 10; page++) {
        const url = new URL(endpoint);
        url.searchParams.set('start_time', String(startMs / 1000));
        url.searchParams.set('end_time', String(endTime));
        url.searchParams.set('bucket_width', '1d');
        url.searchParams.set('limit', '180');
        if (cursor) url.searchParams.set('page', cursor);
        const response = await fetcher(url, {
          headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error',
        });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (result.object !== 'page' || !Array.isArray(result.data) || typeof result.has_more !== 'boolean') throw new Error();
        for (const bucket of result.data) {
          const id = `${bucket.start_time}:${bucket.end_time}`;
          if (bucket.object !== 'bucket' || !Array.isArray(bucket.results)
            || !Number.isInteger(bucket.start_time) || !Number.isInteger(bucket.end_time)
            || bucket.start_time < startMs / 1000 || bucket.start_time >= endTime || bucket.end_time <= bucket.start_time
            || buckets.has(id)) throw new Error();
          buckets.add(id);
          for (const cost of bucket.results) {
            if (cost.object !== 'organization.costs.result' || cost.amount?.currency !== 'usd'
              || !Number.isFinite(cost.amount.value)) throw new Error();
            spentUsd += cost.amount.value;
          }
        }
        if (!result.has_more) { complete = true; break; }
        if (typeof result.next_page !== 'string' || !result.next_page || cursors.has(result.next_page)) throw new Error();
        cursor = result.next_page; cursors.add(cursor);
      }
      if (!complete || !Number.isFinite(spentUsd)) throw new Error();
      // Keep full precision until presentation; individual costs can be fractions of a cent.
      cached = { fundedUsd, spentUsd, remainingCreditUsd: Math.max(0, fundedUsd - spentUsd), startDate,
        updatedAt: new Date(fetchedAt).toISOString() };
      failed = false;
    } catch {
      // Do not expose provider error bodies, administrative credentials or internal details.
      failed = true;
    }
    retryAt = now() + cacheMs;
    return snapshot();
  }
  return async () => {
    if (!configured) return snapshot();
    if (inFlight) return inFlight;
    if (now() < retryAt) return snapshot();
    inFlight = refresh();
    try { return await inFlight; } finally { inFlight = null; }
  };
}
