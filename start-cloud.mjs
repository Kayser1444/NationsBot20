import { prepareCloudConfiguration } from './cloud-config.mjs';
import { adminSettings } from './admin-auth.mjs';
import { cardAssetOrigin } from './card-images.mjs';

try {
  process.env.NATIONS_CONFIG_DIR = prepareCloudConfiguration();
} catch {
  // Do not expose values from a malformed configuration or secret in startup logs.
  console.error('Cloud setup invalid: check the persistent volume, saved friends.json, bot token and Discord destination settings.');
  process.exit(1);
}
if (process.env.NATIONS_CARD_ASSETS_ENABLED === '1') {
  cardAssetOrigin(); // Validate a configured origin; allow private startup before DNS is assigned.
  const assetPort = Number(process.env.NATIONS_CARD_ASSET_PORT ?? 8081);
  if (!Number.isInteger(assetPort) || assetPort < 1 || assetPort > 65535) throw new Error('Invalid card asset port.');
  const { startCardAssetServer } = await import('./card-asset-server.mjs');
  const assets = await startCardAssetServer({ port: assetPort });
  process.once('SIGINT', () => assets.close());
  process.once('SIGTERM', () => assets.close());
}
process.argv = [process.execPath, 'watch-kayser.mjs', '--config', 'friends.json'];
try {
  if (adminSettings()) {
    const port = Number(process.env.PORT ?? 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    process.argv.push('--cloud-admin', '--port', String(port));
  } else process.argv.push('--no-dashboard');
} catch {
  // Fail closed without interrupting the reminder service or logging secrets.
  console.error('Admin console disabled: check its HTTPS origin, OAuth settings and owner ID.');
  process.argv.push('--no-dashboard');
}
await import('./watch-kayser.mjs');
