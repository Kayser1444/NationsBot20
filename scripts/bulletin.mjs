// Local CLI; the key is read from a private file and never printed or sent to an
// arbitrary URL. No Discord credential or Railway console is needed by callers.
import { readFileSync } from 'node:fs';
const origins = { staging: 'https://nationsbot20-staging-admin.up.railway.app', production: 'https://nationsbot20-production.up.railway.app' };
try {
  const [action, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !['environment', 'file', 'key-file', 'id', 'confirm-hash'].includes(name) || !args[i + 1] || options[name]) throw new Error('Invalid arguments.');
    options[name] = args[i + 1];
  }
  if (!['preview', 'publish', 'status'].includes(action) || !origins[options.environment] || !options['key-file']) {
    throw new Error('Usage: node scripts/bulletin.mjs preview|publish|status --environment staging|production --key-file <private-file> [--file <markdown>] [--id <stable-id>] [--confirm-hash <preview-sha256>]');
  }
  const key = readFileSync(options['key-file'], 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid API key file.');
  const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  let route, request;
  if (action === 'status') {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(options.id ?? '')) throw new Error('A stable --id is required.');
    route = '/api/bulletins/' + options.id; request = { method: 'GET', headers };
  } else {
    if (!options.file) throw new Error('--file is required.');
    const content = readFileSync(options.file, 'utf8').trim();
    const body = { environment: options.environment, content };
    route = '/api/bulletins/preview';
    if (action === 'publish') {
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(options.id ?? '') || !/^[a-f0-9]{64}$/.test(options['confirm-hash'] ?? '')) throw new Error('Publishing requires --id and the reviewed --confirm-hash.');
      body.sha256 = options['confirm-hash']; headers['idempotency-key'] = options.id; route = '/api/bulletins';
    }
    request = { method: 'POST', headers, body: JSON.stringify(body) };
  }
  const response = await fetch(origins[options.environment] + route, { ...request, redirect: 'error', signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || action === 'publish' && result.status !== 'verified') process.exitCode = 1;
} catch (error) {
  // Never print requests, credentials or nested transport error causes.
  console.error(error.code || error instanceof TypeError ? 'Bulletin request/file unavailable. Inspect the receipt before retrying a publication.' : error.message);
  process.exitCode = 1;
}
