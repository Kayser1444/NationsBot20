// Creates a narrowly scoped local credential. Only its one-way hash is printed
// for installation in Railway; the actual key stays in the requested file.
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !['staging', 'production'].includes(args[0]) || !args[1].endsWith('.secret')) throw new Error();
  const [environment, filename] = args, file = resolve(filename);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  const key = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error();
  console.log(JSON.stringify({ environment, keyFile: file, variable: 'NATIONS_BULLETIN_API_KEY_SHA256', sha256: createHash('sha256').update(key).digest('hex') }, null, 2));
} catch { console.error('Usage: node scripts/create-bulletin-key.mjs staging|production <private-path.secret>. Existing keys are preserved.'); process.exitCode = 1; }
