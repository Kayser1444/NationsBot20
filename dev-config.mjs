import { resolve } from 'node:path';
import { prepareCloudConfiguration } from './cloud-config.mjs';

const productionApplicationId = '1558936899446374570';
const productionChannelId = '1558878151646388264';
const defaultGuildId = '706912380067643473';
const snowflake = value => /^\d{17,20}$/.test(value ?? '');

// Validate the token remotely before creating state or loading the live bot.
export async function prepareDevelopment({ env = process.env, root, fetcher = fetch }) {
  const token = env.NATIONS_DEV_BOT_TOKEN?.trim();
  const applicationId = env.NATIONS_DEV_APPLICATION_ID;
  const channelId = env.NATIONS_DEV_CHANNEL_ID;
  const guildId = env.NATIONS_DEV_GUILD_ID || defaultGuildId;
  const port = Number(env.NATIONS_DEV_PORT || 24682);
  if (!token || ![applicationId, channelId, guildId].every(snowflake)) {
    throw new Error('Set NATIONS_DEV_BOT_TOKEN, NATIONS_DEV_APPLICATION_ID and NATIONS_DEV_CHANNEL_ID in .env.dev.');
  }
  if (applicationId === productionApplicationId || channelId === productionChannelId) {
    throw new Error('Development must use a separate Discord application and channel.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid NATIONS_DEV_PORT.');
  const request = async path => {
    try {
      const response = await fetcher(`https://discord.com/api/v10${path}`, {
        headers: { authorization: `Bot ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error('Could not verify the development bot or channel. Check the dev token, bot installation and channel permissions.');
    }
  };
  const application = await request('/oauth2/applications/@me');
  if (application.id === productionApplicationId || application.id !== applicationId) {
    throw new Error('Token does not belong to the configured development application; startup refused.');
  }
  const channel = await request(`/channels/${channelId}`);
  if (channel.id !== channelId || channel.guild_id !== guildId || ![0, 5].includes(channel.type)) {
    throw new Error('Development channel does not match the configured server.');
  }
  const directory = resolve(root, '.data', 'dev');
  // Pass only dev values: never inherit a production migration bundle or data path.
  prepareCloudConfiguration({ NATIONS_DATA_DIR: directory, NATIONS_DISCORD_BOT_TOKEN: token,
    NATIONS_DISCORD_GUILD_ID: guildId, NATIONS_DISCORD_CHANNEL_ID: channelId });
  return { directory, token, guildId, channelId, port };
}
