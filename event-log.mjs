import { mkdirSync, existsSync, statSync, renameSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventLog {
  constructor(path, { maxBytes = 2 * 1024 * 1024, output = console.log } = {}) {
    this.path = path; this.maxBytes = maxBytes; this.output = output; this.entries = []; this.error = null;
  }
  add(message, level = 'info') {
    const entry = { time: new Date().toISOString(), message, level };
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.shift();
    this.output(`${new Date(entry.time).toLocaleTimeString('sv-SE')}  ${message}`);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (existsSync(this.path) && statSync(this.path).size >= this.maxBytes) renameSync(this.path, this.path + '.1');
      appendFileSync(this.path, JSON.stringify(entry) + '\n');
      this.error = null;
    } catch { this.error = 'Loggen kunde inte sparas på disk.'; }
    return entry;
  }
}
