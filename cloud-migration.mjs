import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateSubscriptions } from './subscriptions.mjs';

// A private hosting variable seeds a new volume once. Never replay it over live data.
export function importCloudState(directory, encoded, env = {}) {
  if (!encoded) return false;
  const raw = Buffer.from(encoded, 'base64').toString('utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  const marker = join(directory, '.migration-complete');
  if (existsSync(marker)) {
    if (readFileSync(marker, 'utf8') !== hash) throw new Error('A different migration already completed.');
    return false;
  }
  const bundle = JSON.parse(raw);
  const config = bundle.config, outbox = bundle.outbox;
  validateSubscriptions(config?.subscriptions);
  if (bundle.version !== 1 || !Array.isArray(config.matches) ||
      ![config.discord?.guildId, config.discord?.channelId].every(id => /^\d{17,20}$/.test(id ?? '')) ||
      (env.NATIONS_DISCORD_GUILD_ID && env.NATIONS_DISCORD_GUILD_ID !== config.discord.guildId) ||
      (env.NATIONS_DISCORD_CHANNEL_ID && env.NATIONS_DISCORD_CHANNEL_ID !== config.discord.channelId) ||
      outbox?.version !== 1 || !outbox.turns || !Array.isArray(outbox.jobs) ||
      outbox.destination?.guildId !== config.discord.guildId || outbox.destination?.channelId !== config.discord.channelId) {
    throw new Error('Invalid migration destination or state.');
  }
  const files = [['friends.json', config], ['friends-outbox.json', outbox]];
  // Preflight every file before writing any; interrupted imports can resume.
  for (const [name, value] of files) {
    const path = join(directory, name);
    if (existsSync(path) && JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== JSON.stringify(value)) {
      throw new Error('Migration would overwrite existing state.');
    }
  }
  for (const [name, value] of files) {
    const path = join(directory, name);
    if (existsSync(path)) continue;
    writeFileSync(path + '.migration.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(path + '.migration.tmp', path);
  }
  writeFileSync(marker, hash, { mode: 0o600 });
  return true;
}
