import { existsSync, readFileSync, copyFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';

// An optional owner-supplied checkpoint repairs already-truncated intervals once.
// It contains observations only; it cannot change tracking, reminders or subscriptions.
export function recoverTurnJournal(journal, sourcePath = journal.path + '.recovery.json') {
  if (!existsSync(sourcePath)) return 0;
  const source = readFileSync(sourcePath, 'utf8'), checkpoint = JSON.parse(source);
  if (checkpoint.version !== 1 || !Array.isArray(checkpoint.observations) || checkpoint.observations.length > 1000) throw new Error('Invalid thinking checkpoint.');
  const original = journal.data, next = structuredClone(original);
  let updated = 0;
  for (const observation of checkpoint.observations) {
    if (!/^\d+$/.test(observation.matchId) || typeof observation.player !== 'string' || !observation.player
      || !Number.isFinite(observation.startedAt) || observation.startedAt < 0
      || !Number.isFinite(observation.durationMs) || observation.durationMs < 0
      || observation.startedAt + observation.durationMs > journal.now() + 1000) throw new Error('Invalid thinking checkpoint.');
    const matches = next.records.filter(record => record.matchId === observation.matchId && record.player === observation.player
      && Math.floor(record.startedAt / 1000) === Math.floor(observation.startedAt / 1000));
    if (matches.length !== 1) throw new Error('Thinking checkpoint does not match a unique saved interval.');
    const record = matches[0];
    // The old page displayed start times to seconds and elapsed time to tenths.
    let endedAt = record.startedAt + observation.durationMs;
    for (const other of next.records) if (other !== record && other.matchId === record.matchId && other.startedAt > record.startedAt) endedAt = Math.min(endedAt, other.startedAt);
    if (endedAt <= record.endedAt) continue;
    record.endedAt = endedAt; record.durationMs = endedAt - record.startedAt;
    record.partial = true; record.recovered = true; updated++;
  }
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const backup = journal.path + '.before-recovery-' + digest;
  if (!existsSync(backup)) copyFileSync(journal.path, backup);
  journal.data = next;
  try { journal.save(); } catch (error) { journal.data = original; throw error; }
  renameSync(sourcePath, sourcePath + '.applied-' + digest);
  return updated;
}
