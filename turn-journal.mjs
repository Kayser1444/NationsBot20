import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
export const DAY = 86400000;
export function reminderOptions(time, timezone = 'Etc/GMT') {
  if (time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Use HH:mm (00:00–23:59).');
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  return { time: time ?? null, timezone };
}
function local(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
export function reminderSlot(turn, preference, now) {
  if (!preference?.enabled || turn.over || !turn.player) return null;
  if (!preference.time) {
    const slot = Math.floor((now - turn.startedAt) / DAY);
    return slot >= 1 ? String(slot) : null;
  }
  const current = local(now, preference.timezone);
  const start = local(turn.startedAt, preference.timezone);
  return current.time >= preference.time && (current.date > start.date || start.time < preference.time) ? current.date : null;
}
// Persistent observations: an initial snapshot is a partial turn, not historical timing.
export class TurnJournal {
  constructor(path, now = Date.now) {
    this.path = path; this.now = now;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, turns: {}, tracking: {}, records: [], receipts: {} };
    if (this.data.version !== 1 || !this.data.turns || !this.data.tracking || !Array.isArray(this.data.records) || !this.data.receipts) throw new Error('Invalid turn journal.');
    for (const id of Object.keys(this.data.turns)) this.suspend(id);
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', JSON.stringify(this.data, null, 2) + '\n');
    renameSync(this.path + '.tmp', this.path);
  }
  track(id, enabled) {
    if (!/^\d+$/.test(id)) throw new Error('Ogiltigt parti-ID.');
    if (enabled && !this.data.tracking[id]) { this.data.tracking[id] = true; const turn = this.data.turns[id]; if (turn && !turn.over && !turn.suspended) { turn.trackedAt = this.now(); turn.partial = true; } }
    if (!enabled && this.data.tracking[id]) { this.close(id, this.now(), 'disabled'); delete this.data.tracking[id]; }
    this.save();
  }
  close(id, now, reason) {
    const turn = this.data.turns[id];
    if (turn?.trackedAt != null && turn.player && !turn.over) {
      this.data.records.push({ matchId: id, player: turn.player, move: turn.move, startedAt: turn.trackedAt, endedAt: now, durationMs: now - turn.trackedAt, partial: Boolean(turn.partial || reason === 'disabled' || reason === 'disconnected'), reason });
      delete turn.trackedAt;
    }
  }
  contact(id) {
    const turn = this.data.turns[id];
    if (!turn || turn.suspended || turn.over) return;
    turn.lastSeenAt = this.now();
    this.save();
  }
  suspend(id, observedUntil = null) {
    const turn = this.data.turns[id];
    if (!turn || turn.suspended || turn.over) return;
    this.close(id, Math.max(turn.trackedAt ?? 0, observedUntil ?? turn.lastSeenAt ?? turn.startedAt), 'disconnected');
    turn.suspended = true;
    this.save();
  }
  observe(id, state) {
    const old = this.data.turns[id], now = this.now();
    // Consecutive moves by the same player are separate thinking intervals.
    if (old && old.player === state.player && old.move === state.move && old.over === state.over && !old.suspended) {
      old.lastSeenAt = now; this.save(); return;
    }
    this.close(id, now, state.over ? 'complete' : 'move');
    const playerChanged = !old || old.player !== state.player || old.over !== state.over;
    this.data.turns[id] = { ...state, lastSeenAt: now, startedAt: playerChanged ? now : old.startedAt, generation: (old?.generation ?? 0) + (playerChanged ? 1 : 0), ...(this.data.tracking[id] && !state.over ? { trackedAt: now, partial: !old || Boolean(old.suspended) } : {}) };
    if (playerChanged) for (const key of Object.keys(this.data.receipts)) if (key.startsWith(id + ':')) delete this.data.receipts[key];
    this.save();
  }
  due(id, userId, preference) {
    const turn = this.data.turns[id]; if (!turn) return null;
    const slot = reminderSlot(turn, preference, this.now());
    const key = `${id}:${userId}:${turn.generation}`;
    return slot && this.data.receipts[key] !== slot ? { key, slot, player: turn.player, generation: turn.generation } : null;
  }
  receipt(job) { this.data.receipts[job.key] = job.slot; this.save(); }
}
