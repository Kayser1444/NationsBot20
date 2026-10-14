import { fileURLToPath } from 'node:url';
import { prepareDevelopment } from './dev-config.mjs';

let settings;
try {
  settings = await prepareDevelopment({ root: fileURLToPath(new URL('.', import.meta.url)) });
} catch (error) {
  console.error(`Development startup stopped: ${error.message}`);
  process.exit(1);
}
process.env.NATIONS_CONFIG_DIR = settings.directory;
process.env.NATIONS_DATA_DIR = settings.directory;
process.env.NATIONS_DISCORD_BOT_TOKEN = settings.token;
process.env.NATIONS_DISCORD_GUILD_ID = settings.guildId;
process.env.NATIONS_DISCORD_CHANNEL_ID = settings.channelId;
process.env.NATIONS_ADMIN_ENABLED = '0';
delete process.env.NATIONS_DISCORD_WEBHOOK;
delete process.env.NATIONS_MIGRATION_BUNDLE;
console.log(`LOCAL DEVELOPMENT BOT — channel ${settings.channelId}; state ${settings.directory}`);
console.log(`Local administration: http://127.0.0.1:${settings.port} — Ctrl+C stops the test bot.`);
process.argv = [process.execPath, 'watch-kayser.mjs', '--config', 'friends.json', '--port', String(settings.port)];
await import('./watch-kayser.mjs');
