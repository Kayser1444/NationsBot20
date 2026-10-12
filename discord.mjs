// Incoming-webhook delivery. The webhook URL is never included in errors/logs.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class DiscordDeliveryError extends Error {
  constructor(message, { retryable = true, retryAfterMs = 0 } = {}) {
    super(message); this.retryable = retryable; this.retryAfterMs = retryAfterMs;
  }
}
export function webhookUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The Discord webhook URL is invalid.'); }
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname) || url.port ||
      url.username || url.password || url.hash ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw new Error('Use a webhook URL copied from discord.com.');
  }
  url.hostname = 'discord.com';
  url.search = '?wait=true';
  return url;
}
export async function verifyDiscordDestination(url, expected, { fetcher = fetch, signal } = {}) {
  const infoUrl = new URL(url);
  infoUrl.search = '';
  let response;
  try {
    response = await fetcher(infoUrl, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  } catch {
    throw new DiscordDeliveryError('Could not verify the Discord webhook destination. Nothing was sent.');
  }
  if (!response.ok) {
    const limit = response.status === 429 ? await response.json().catch(() => ({})) : {};
    const delay = Number(limit.retry_after);
    throw new DiscordDeliveryError(`Discord webhook verification failed (HTTP ${response.status}). Nothing was sent.`, {
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: Number.isFinite(delay) && delay >= 0 ? delay * 1000 : 0,
    });
  }
  const info = await response.json().catch(() => null);
  if (!info || info.channel_id !== expected.channelId || info.guild_id !== expected.guildId) {
    throw new DiscordDeliveryError('This webhook does not belong to the selected Nations sandbox channel. Nothing was sent.', { retryable: false });
  }
  return { channelId: info.channel_id, guildId: info.guild_id };
}
function mention(userId) {
  if (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) {
    throw new Error('A numeric Discord user ID is needed for a direct mention.');
  }
  return { text: `<@${userId}>`, allowed: { parse: [], users: [userId] } };
}
export function turnMessage(username, match, userId) {
  const recipient = userId ? mention(userId) : { text: username, allowed: { parse: [] } };
  const title = (match.title || `Parti ${match.id}`).replace(/\s+/g, ' ').trim().slice(0, 250)
    .replace(/[\\\[\]*_~`]/g, '\\$&');
  return {
    username: 'Nations',
    content: `${recipient.text} — Din tur i [${title}](<https://games.tabony.net/nations/${match.id}/>)`,
    allowed_mentions: recipient.allowed,
  };
}
export function testMessage(userId) {
  const recipient = mention(userId);
  return {
    username: 'Nations',
    content: `${recipient.text} — Nations mention test. This is a test, not a turn alert. Did this trigger a notification on your phone?`,
    allowed_mentions: recipient.allowed,
  };
}
export async function sendDiscord(url, payload, { fetcher = fetch, pause = sleep, attempts = 4, signal } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
    } catch {
      if (signal?.aborted || attempt === attempts - 1) throw new DiscordDeliveryError('Discord did not confirm delivery. Check your connection.');
      await pause(1000 * 2 ** attempt); continue;
    }
    if (response.ok) {
      const message = await response.json().catch(() => null);
      if (message?.id) return {
        messageId: message.id, channelId: message.channel_id,
        mentionedUserIds: (message.mentions ?? []).map(user => user.id),
      };
      throw new DiscordDeliveryError('Discord returned no message confirmation.');
    }
    if (response.status === 429) {
      const limits = await response.json().catch(() => ({}));
      const delay = Number(limits.retry_after ?? 2);
      const retryAfterMs = Number.isFinite(delay) && delay >= 0 ? Math.max(1000, delay * 1000) : 60000;
      if (attempt === attempts - 1 || retryAfterMs > 60000) {
        throw new DiscordDeliveryError('Discord is rate-limiting delivery; try again later.', { retryAfterMs });
      }
      await pause(retryAfterMs); continue;
    }
    if (response.status >= 500 && attempt < attempts - 1) {
      await pause(1000 * 2 ** attempt); continue;
    }
    throw new DiscordDeliveryError(`Discord rejected delivery (HTTP ${response.status}). Check the configured webhook.`, { retryable: response.status >= 500 });
  }
}
