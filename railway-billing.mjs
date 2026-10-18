const endpoint = 'https://backboard.railway.com/graphql/v2';
const cacheMs = 15 * 60 * 1000;
const query = `query AdminRailwayBilling($workspaceId: String!) {
  workspace(workspaceId: $workspaceId) {
    customer { isTrialing trialDaysRemaining remainingUsageCreditBalance }
  }
}`;

export function createRailwayBilling({ env = process.env, fetcher = fetch, now = Date.now } = {}) {
  const token = env.NATIONS_RAILWAY_API_TOKEN?.trim();
  const workspaceId = env.NATIONS_RAILWAY_WORKSPACE_ID?.trim();
  const configured = Boolean(token && workspaceId);
  let cached = null, retryAt = 0, inFlight = null, failed = false;
  const snapshot = () => ({
    configured, available: cached !== null, stale: cached !== null && failed,
    updatedAt: null, ...cached,
    error: !configured ? 'Railway-information är inte aktiverad.'
      : failed ? 'Railway-informationen kunde inte hämtas. Ett nytt försök görs senare.' : null,
  });
  async function refresh() {
    try {
      const response = await fetcher(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables: { workspaceId } }),
        signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      const customer = result.data?.workspace?.customer;
      if (result.errors?.length || typeof customer?.isTrialing !== 'boolean'
        || !Number.isInteger(customer.trialDaysRemaining) || customer.trialDaysRemaining < 0
        || !Number.isFinite(customer.remainingUsageCreditBalance)) throw new Error();
      cached = { isTrialing: customer.isTrialing, trialDaysRemaining: customer.trialDaysRemaining,
        remainingCreditUsd: Math.max(0, customer.remainingUsageCreditBalance), updatedAt: new Date(now()).toISOString() };
      failed = false;
      retryAt = now() + cacheMs;
    } catch {
      // Provider errors can contain credentials or internal details; expose only a fixed message.
      failed = true;
      retryAt = now() + cacheMs;
    }
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
