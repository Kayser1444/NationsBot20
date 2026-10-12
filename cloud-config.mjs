import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validateSubscriptions } from './subscriptions.mjs';
import { importCloudState } from './cloud-migration.mjs';

export function prepareCloudConfiguration(env = process.env) {
  if (!env.NATIONS_DISCORD_BOT_TOKEN) throw new Error('Set NATIONS_DISCORD_BOT_TOKEN in the hosting service secrets.');
  const directory = env.NATIONS_DATA_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error('NATIONS_DATA_DIR must be an absolute persistent volume path.');
  const configPath = join(directory, 'friends.json');
  mkdirSync(directory, { recursive: true });
  importCloudState(directory, env.NATIONS_MIGRATION_BUNDLE, env);
  if (!existsSync(configPath)) {
    if (![env.NATIONS_DISCORD_GUILD_ID, env.NATIONS_DISCORD_CHANNEL_ID].every(id => /^\d{17,20}$/.test(id ?? ''))) {
      throw new Error('Set valid NATIONS_DISCORD_GUILD_ID and NATIONS_DISCORD_CHANNEL_ID before first startup.');
    }
    writeFileSync(configPath, JSON.stringify({ subscriptions: {}, matches: [],
      discord: { guildId: env.NATIONS_DISCORD_GUILD_ID, channelId: env.NATIONS_DISCORD_CHANNEL_ID },
      lastNationsNames: {}, dmPreferences: {},
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  // Never silently replace live subscriptions, delivery preferences, or destination.
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  validateSubscriptions(config.subscriptions);
  if (!Array.isArray(config.matches) || ![config.discord?.guildId, config.discord?.channelId].every(id => /^\d{17,20}$/.test(id ?? ''))) {
    throw new Error('Invalid saved configuration on the persistent volume.');
  }
  if ((env.NATIONS_DISCORD_GUILD_ID && env.NATIONS_DISCORD_GUILD_ID !== config.discord.guildId) ||
      (env.NATIONS_DISCORD_CHANNEL_ID && env.NATIONS_DISCORD_CHANNEL_ID !== config.discord.channelId)) {
    throw new Error('Saved Discord destination differs from the hosting settings; review it before starting.');
  }
  return directory;
}
