export function questionMetrics(record) {
  const events = record.telemetry ?? [], requests = events.filter(event => event.type === 'request');
  const api = events.filter(event => event.type === 'api'), priced = api.filter(event => Number.isFinite(event.estimatedCostUsd));
  const expectedCalls = Math.max(record.usage?.reportedRequests ?? 0, requests.length);
  const config = events.find(event => event.type === 'configuration');
  const models = [...new Set(requests.map(event => event.model).filter(Boolean))];
  const tiers = [...new Set(api.map(event => event.serviceTier).filter(Boolean))];
  const all = field => api.length > 0 && api.length === expectedCalls && api.every(event => Number.isFinite(event[field]))
    ? api.reduce((total, event) => total + event[field], 0) : null;
  return { model: config?.model ?? (models.length === 1 ? models[0] : null),
    responseModels: [...new Set(api.map(event => event.responseModel).filter(Boolean))],
    reasoningEffort: config?.reasoningEffort ?? null, promptHash: config?.promptHash ?? null,
    corpusHash: events.find(event => event.type === 'retrieval' && event.phase === 'selected')?.corpusHash ?? null,
    retrieval: events.find(event => event.type === 'retrieval' && event.phase === 'selected')?.name ?? null,
    apiCalls: expectedCalls, apiDurationMs: all('durationMs'), cachedInputTokens: all('cachedInputTokens'), reasoningTokens: all('reasoningTokens'),
    serviceTiers: tiers, pricedRequests: priced.length,
    estimatedCostUsd: expectedCalls > 0 && priced.length === expectedCalls ? priced.reduce((total, event) => total + event.estimatedCostUsd, 0) : null,
    pricingDates: [...new Set(priced.map(event => event.pricingDate).filter(Boolean))] };
}
