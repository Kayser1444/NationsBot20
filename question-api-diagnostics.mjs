// Provider error text is untrusted: retain selected fields, never headers or raw bodies.
export function safeDiagnostic(value, max = 160, secret = '') {
  if (typeof value !== 'string') return undefined;
  let text = secret ? value.split(secret).join('[redacted]') : value;
  return text.replace(/Bearer\s+[^\s;,]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

export async function questionApiDiagnostics(response, apiKey) {
  const diagnostics = { requestId: safeDiagnostic(response.headers.get('x-request-id'), 160, apiKey) };
  // Bound error reads as well as persisted text; proxies may return HTML or oversized bodies.
  const reader = response.body?.getReader();
  if (!reader) return diagnostics;
  try {
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) return diagnostics;
      chunks.push(Buffer.from(value));
    }
    const error = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error;
    for (const [field, source, max] of [['errorCode', 'code', 160], ['errorType', 'type', 160], ['errorParam', 'param', 160], ['errorMessage', 'message', 1000]]) {
      const value = safeDiagnostic(error?.[source], max, apiKey);
      if (value !== undefined) diagnostics[field] = value;
    }
  } catch { /* Status and request ID remain useful for non-JSON or interrupted errors. */ }
  finally { void reader.cancel().catch(() => {}); }
  return diagnostics;
}
