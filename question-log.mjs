import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveQuestionJson } from './question-sources.mjs';

const cut = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : null;
export function createQuestionLog({ directory, now = Date.now, maxRecords = 500, maxAgeMs = 30 * 86400000, report = () => {} } = {}) {
  let records = [], path = null, available = true;
  const save = () => { if (path) saveQuestionJson(path, { schemaVersion: 1, records }); };
  const prune = () => { records = records.filter(record => Date.parse(record.startedAt) >= now() - maxAgeMs).slice(-maxRecords); };
  try {
    if (directory) {
      const root = join(directory, 'questions'); mkdirSync(root, { recursive: true }); path = join(root, 'conversations.json');
      if (existsSync(path)) {
        if (statSync(path).size > 25 * 1024 * 1024) throw new Error();
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (data.schemaVersion !== 1 || !Array.isArray(data.records) || data.records.some(record =>
          !record?.id || !Number.isFinite(Date.parse(record.startedAt)) || typeof record.question !== 'string' ||
          !Array.isArray(record.parts) || !Array.isArray(record.telemetry))) throw new Error();
        records = data.records;
        for (const record of records) if (record.status === 'processing') Object.assign(record, {
          status: 'interrupted', finishedAt: new Date(now()).toISOString(), deliveryStatus: 'unknown', failure: 'process_restarted',
        });
      }
      prune(); save();
    }
  } catch { available = false; report('Frågeloggen kunde inte läsas. Nya frågor är avstängda tills loggen kan sparas.', 'error'); }
  function update(id, values) {
    if (!available) throw new Error('Question log unavailable.');
    const record = records.find(item => item.id === id);
    if (!record) return;
    Object.assign(record, structuredClone(values));
    try { save(); } catch { available = false; throw new Error('Question log could not be saved.'); }
  }
  return {
    get available() { return available; },
    start(input) {
      if (!available) throw new Error('Question log unavailable.');
      prune();
      const id = randomUUID();
      records.push({ id, startedAt: new Date(now()).toISOString(), receivedAt: Number.isFinite(input.receivedAt) ? input.receivedAt : now(),
        userId: cut(input.userId), userName: cut(input.userName), guildId: cut(input.guildId), guildName: cut(input.guildName),
        channelId: cut(input.channelId), channelName: cut(input.channelName), location: input.guildId ? 'channel' : 'dm',
        requestedLanguage: cut(input.language, 35), question: cut(input.question, 1200) ?? '',
        status: 'processing', deliveryStatus: 'pending', parts: [], telemetry: [], usage: { inputTokens: 0, outputTokens: 0, reportedRequests: 0 },
        translation: { status: 'unavailable', targetLanguage: 'en', question: null, parts: [], label: 'No completed model translation available.' },
      });
      records = records.slice(-maxRecords); update(id, {}); return id;
    },
    update,
    telemetry(id, event) {
      const record = records.find(item => item.id === id); if (!record) return;
      // Explicit fields only: never persist headers, API keys, interaction tokens or raw provider errors.
      const safe = {};
      for (const key of ['type', 'phase', 'name', 'sourceId', 'query', 'errorCode', 'responseId', 'model']) if (typeof event[key] === 'string') safe[key] = cut(event[key], key === 'query' ? 240 : 160);
      for (const key of ['round', 'durationMs', 'status', 'inputTokens', 'outputTokens', 'resultCount', 'start', 'count']) if (Number.isFinite(event[key])) safe[key] = event[key];
      const usage = { ...record.usage };
      if (safe.type === 'api' && Number.isFinite(safe.inputTokens) && Number.isFinite(safe.outputTokens)) {
        usage.inputTokens += safe.inputTokens; usage.outputTokens += safe.outputTokens; usage.reportedRequests++;
      }
      update(id, { telemetry: [...record.telemetry, safe].slice(-64), usage });
    },
    finish(id, values = {}) {
      const record = records.find(item => item.id === id); if (!record) return;
      update(id, { ...values, finishedAt: new Date(now()).toISOString(), durationMs: Math.max(0, now() - record.receivedAt) });
    },
    list({ offset = 0, limit = 20, search = '', status = '' } = {}) {
      const term = String(search).slice(0, 200).toLowerCase();
      const selected = records.filter(record => Date.parse(record.startedAt) >= now() - maxAgeMs && (!status || record.status === status) &&
        (!term || [record.question, record.userId, record.userName, record.channelName, record.channelId, record.guildName].some(value => value?.toLowerCase().includes(term)))).slice().reverse();
      const start = Math.max(0, Math.floor(Number(offset) || 0)), size = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
      return { available, total: selected.length, offset: start, limit: size, retentionDays: maxAgeMs / 86400000, maxRecords,
        records: selected.slice(start, start + size).map(({ id, startedAt, userId, userName, location, channelName, guildName, status, durationMs, parts, translation, question }) =>
          ({ id, startedAt, userId, userName, location, channelName, guildName, status, durationMs, partCount: parts.length, translationStatus: translation?.status ?? 'pending',
            question: question.slice(0, 160) })) };
    },
    read(id) { const record = records.find(item => item.id === id && Date.parse(item.startedAt) >= now() - maxAgeMs); return record ? structuredClone(record) : null; },
  };
}
