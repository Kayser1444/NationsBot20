import { DiscordDeliveryError } from './discord.mjs';

export function botDelivery(token, expected, { fetcher = fetch } = {}) {
  if (!token || !/^\d{17,20}$/.test(expected.channelId) || !/^\d{17,20}$/.test(expected.guildId)) throw new Error('Bot-token och giltig Discord-kanal behövs.');
  const channelUrl = `https://discord.com/api/v10/channels/${expected.channelId}`;
  async function request(url, { method = 'GET', body, signal } = {}) {
    let response;
    try {
      response = await fetcher(url, { method, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new DiscordDeliveryError('Discord-boten fick ingen leveransbekräftelse. Kontrollera anslutningen.'); }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const delay = Number(detail.retry_after);
      const code = Number(detail.code);
      const reason = code === 50001 ? 'Boten saknar åtkomst till påminnelsekanalen. Ge Nations Bot 2.0 behörigheten Visa kanal där.'
        : code === 50013 ? 'Boten saknar kanalbehörighet. Ge Nations Bot 2.0 behörigheterna Visa kanal och Skicka meddelanden där.'
        : [50007, 50278].includes(code) ? 'Discord tillåter inte DM till användaren. Inget skickas i den publika kanalen. Tillåt DM från boten och använd /dm on igen.'
        : 'Kontrollera bot-token och kanalbehörigheter.';
      throw new DiscordDeliveryError(`Discord-boten nekades åtkomst eller leverans (HTTP ${response.status}${Number.isFinite(code) ? ', kod ' + code : ''}). ${reason}`, {
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: Number.isFinite(delay) && delay >= 0 ? delay * 1000 : 0,
      });
    }
    return response.json().catch(() => null);
  }
  async function sendToChannel(channelId, payload, signal) {
    const message = await request(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', signal,
      body: { content: payload.content, allowed_mentions: payload.allowed_mentions ?? { parse: [] } },
    });
    if (!message?.id || message.channel_id !== channelId) throw new DiscordDeliveryError('Discord returnerade ingen giltig leveransbekräftelse för boten.');
    return { messageId: message.id, channelId: message.channel_id, mentionedUserIds: (message.mentions ?? []).map(user => user.id) };
  }
  return {
    async verify(signal) {
      const channel = await request(channelUrl, { signal });
      if (!channel || channel.id !== expected.channelId || channel.guild_id !== expected.guildId || ![0, 5].includes(channel.type)) {
        throw new DiscordDeliveryError('Botens kanal matchar inte den valda påminnelsekanalen. Inget skickades.', { retryable: false });
      }
    },
    async send(payload, signal) {
      // Webhook-only sender names are deliberately excluded: the bot is the author.
      return sendToChannel(expected.channelId, payload, signal);
    },
    async sendReminder(payload, userId, getDm, signal, isCurrent = () => true) {
      const dm = getDm(userId);
      let channelId = expected.channelId;
      if (dm) {
        const channel = await request('https://discord.com/api/v10/users/@me/channels', { method: 'POST', body: { recipient_id: userId }, signal });
        if (!channel || channel.type !== 1 || !/^\d{17,20}$/.test(channel.id) || channel.recipients?.length !== 1 || channel.recipients[0].id !== userId) {
          throw new DiscordDeliveryError('Discord returnerade inte användarens DM-kanal. Inget skickades.', { retryable: false });
        }
        channelId = channel.id;
      }
      if (getDm(userId) !== dm || !isCurrent() || signal?.aborted) throw new DiscordDeliveryError('Inställningen eller turen ändrades före leverans.');
      return sendToChannel(channelId, payload, signal);
    },
  };
}
