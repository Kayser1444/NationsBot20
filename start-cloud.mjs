import { prepareCloudConfiguration } from './cloud-config.mjs';

try {
  process.env.NATIONS_CONFIG_DIR = prepareCloudConfiguration();
} catch {
  // Do not expose values from a malformed configuration or secret in startup logs.
  console.error('Cloud setup invalid: check the persistent volume, saved friends.json, bot token and Discord destination settings.');
  process.exit(1);
}
process.argv = [process.execPath, 'watch-kayser.mjs', '--config', 'friends.json', '--no-dashboard'];
await import('./watch-kayser.mjs');
