import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

// Only hashes of browser session tokens are persisted; OAuth tokens are excluded.
export function sessionStore(path, context, now) {
  const records = new Map();
  if (path && existsSync(path)) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Invalid admin session store.');
    if (JSON.stringify(data.context) === JSON.stringify(context)) {
      for (const [key, value] of data.sessions) {
        if (!/^[a-f0-9]{64}$/.test(key) || value?.userId !== context.ownerId ||
            !/^[a-f0-9]{64}$/.test(value.csrf) || !Number.isFinite(value.expires) || value.remember !== true) throw new Error('Invalid saved admin session.');
        if (value.expires > now()) records.set(key, value);
      }
      if (records.size > 10) throw new Error('Too many saved admin sessions.');
    }
  }
  function save() {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const temp = path + '.tmp';
    writeFileSync(temp, JSON.stringify({ version: 1, context,
      sessions: [...records].filter(([, value]) => value.remember && value.expires > now()) }) + '\n', { mode: 0o600 });
    const fd = openSync(temp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  }
  return { records, save };
}
