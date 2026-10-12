import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// The last complete public listing remains usable while offline or after a restart.
export class PlayerCache {
  constructor(path, report = () => {}) {
    this.path = path; this.report = report; this.names = []; this.updatedAt = null;
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.names) || data.names.some(name => typeof name !== 'string' || !name.trim()) || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error();
      this.names = [...new Set(data.names)].sort((a, b) => a.localeCompare(b, 'sv'));
      this.updatedAt = data.updatedAt;
    } catch { report('Spelarnamnscachen kunde inte läsas. Hämtar en ny lista.', 'error'); }
  }
  update(matches) {
    this.names = [...new Set(matches.flatMap(match => match.players))].sort((a, b) => a.localeCompare(b, 'sv'));
    this.updatedAt = new Date().toISOString();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path + '.tmp', JSON.stringify({ version: 1, updatedAt: this.updatedAt, names: this.names }, null, 2) + '\n');
      renameSync(this.path + '.tmp', this.path);
    } catch { this.report('Spelarnamnscachen kunde inte sparas. Namnförslagen fungerar under denna körning.', 'error'); }
  }
}
