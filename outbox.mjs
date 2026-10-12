import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

// One persisted turn record per match; jobs never contain webhook credentials.
export class Outbox {
  constructor(path, destination, { now = Date.now } = {}) {
    this.path = path; this.now = now; this.busy = false; this.cooldown = 0;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, destination, turns: {}, jobs: [] };
    if (this.data.version !== 1 || JSON.stringify(this.data.destination) !== JSON.stringify(destination) ||
        !this.data.turns || !Array.isArray(this.data.jobs)) throw new Error('Outbox format or destination mismatch.');
    // Restart after fixing credentials permits blocked jobs to be retried.
    for (const job of this.data.jobs) job.blocked = false;
    this.save();
  }
  save() {
    try {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = this.path + '.tmp';
    writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    const fd = openSync(temp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
    } catch {
      const error = new Error('Could not save the outbox.');
      error.outboxPersistence = true;
      throw error;
    }
  }
  observe(match, state, userId) {
    const prior = this.data.turns[match.id];
    const changed = !prior || prior.player !== state.player || prior.over !== state.over;
    const turn = changed ? { player: state.player, over: state.over, generation: (prior?.generation ?? 0) + 1, sent: false } : prior;
    this.data.turns[match.id] = turn;
    const key = `${match.id}:${turn.generation}`;
    const oldLength = this.data.jobs.length;
    this.data.jobs = this.data.jobs.filter(job => job.matchId !== match.id || job.key === key);
    let added = false;
    if (!state.over && userId && !turn.sent && !this.data.jobs.some(job => job.key === key)) {
      this.data.jobs.push({ key, matchId: match.id, title: match.title, player: state.player, userId, attempts: 0, nextAt: this.now(), blocked: false });
      added = true;
    }
    if (changed || added || oldLength !== this.data.jobs.length) this.save();
    return added;
  }
  current(job) {
    const turn = this.data.turns[job.matchId];
    return this.data.jobs.includes(job) && !turn.over && turn.player === job.player && job.key === `${job.matchId}:${turn.generation}`;
  }
  updateSubscriptions(previous, selected) {
    this.data.jobs = this.data.jobs.filter(job => selected[job.player] === job.userId);
    for (const turn of Object.values(this.data.turns)) {
      if (selected[turn.player] && previous[turn.player] !== selected[turn.player]) turn.sent = false;
    }
    this.save();
  }
  retryUser(userId) {
    for (const job of this.data.jobs) if (job.userId === userId && job.blocked) { job.blocked = false; job.nextAt = this.now(); }
    this.save();
  }
  async flush({ validate, send, signal, report = () => {} }) {
    if (this.busy || signal?.aborted || this.now() < this.cooldown) return;
    this.busy = true;
    try {
      for (const job of [...this.data.jobs]) {
        if (signal?.aborted) break;
        if (job.blocked || job.nextAt > this.now() || !this.current(job)) continue;
        try {
          const valid = await validate(job);
          if (signal?.aborted) break;
          if (!this.current(job)) continue;
          if (!valid) {
            this.data.turns[job.matchId].sent = true;
            this.data.jobs = this.data.jobs.filter(item => item !== job);
            this.save(); report(`discarded expired turn for ${job.matchId}`); continue;
          }
          report(`sending turn alert for ${job.matchId}`);
          await send(job);
        } catch (error) {
          if (error.outboxPersistence) throw error;
          if (signal?.aborted) break;
          if (!this.current(job)) continue;
          job.attempts++;
          job.blocked = error.retryable === false;
          const delay = Math.max(Math.min(60000 * 2 ** Math.min(job.attempts - 1, 4), 900000), error.retryAfterMs || 0);
          job.nextAt = this.now() + delay;
          this.save();
          report(job.blocked ? `BLOCKED for ${job.matchId}: ${error.message}; fix configuration and restart` : `RETRY for ${job.matchId} in ${Math.ceil(delay / 1000)}s: ${error.message}`);
          if (!job.blocked) { this.cooldown = job.nextAt; break; }
          continue;
        }
        // Save errors are fatal: do not mistake a failed receipt write for a send error.
        if (this.current(job)) this.data.turns[job.matchId].sent = true;
        this.data.jobs = this.data.jobs.filter(item => item !== job);
        this.save(); report(`last alert confirmed for ${job.matchId}`);
      }
    } finally { this.busy = false; }
  }
}
