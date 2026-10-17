import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const digest = text => createHash('sha256').update(text).digest('hex');
const idPattern = /^[a-zA-Z0-9_-]{8,80}$/;
const discordId = /^\d{17,20}$/;
export class BulletinError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new BulletinError(status, message); };

// This credential can only authorize the three bulletin routes. It cannot open
// the owner dashboard, inspect questions, change subscribers or choose a target.
export function bulletinCredentialMatches(authorization, keyHash) {
  if (!/^[a-f0-9]{64}$/.test(keyHash ?? '') || !/^Bearer [a-f0-9]{64}$/.test(authorization ?? '')) return false;
  return timingSafeEqual(Buffer.from(digest(authorization.slice(7)), 'hex'), Buffer.from(keyHash, 'hex'));
}

export function createBulletinService({ directory, environment, guildId, channelId, botId, token, fetcher = fetch, now = Date.now }) {
  if (!directory || !['staging', 'production'].includes(environment) || ![guildId, channelId, botId].every(id => discordId.test(id ?? '')) || !token) {
    throw new Error('Invalid bulletin service configuration.');
  }
  const root = join(directory, 'bulletins');
  mkdirSync(root, { recursive: true });
  const destination = { guildId, channelId, botId };
  const locks = new Set();
  function validate(input) {
    if (!input || input.environment !== environment) fail(409, 'Fel miljö.');
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 2000 || /<@|@everyone|@here/i.test(input.content)) {
      fail(400, 'Bulletinen måste innehålla 1–2000 tecken och får inte innehålla omnämnanden.');
    }
    return { environment, destination, content: input.content, length: input.content.length, sha256: digest(input.content) };
  }
  function path(id) {
    if (!idPattern.test(id ?? '')) fail(400, 'Ogiltig publiceringsnyckel.');
    return join(root, id + '.json');
  }
  function read(id) {
    const file = path(id);
    if (!existsSync(file)) return null;
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record.id !== id || record.environment !== environment || JSON.stringify(record.destination) !== JSON.stringify(destination) ||
          !['publishing', 'sent', 'verified', 'uncertain', 'failed'].includes(record.status) || digest(record.content) !== record.sha256) throw new Error();
      return record;
    } catch { fail(503, 'Publiceringskvittot kunde inte verifieras. Inget nytt skickas.'); }
  }
  function save(record, initial = false) {
    const file = path(record.id), text = JSON.stringify(record, null, 2) + '\n';
    // Reserve before POST. A crash or an uncertain response never authorizes
    // another POST, even after a process restart or Discord's nonce window.
    if (initial) writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
    else {
      writeFileSync(file + '.tmp', text, { mode: 0o600 });
      renameSync(file + '.tmp', file);
    }
  }
  async function request(resource, options = {}) {
    return fetcher('https://discord.com/api/v10' + resource, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: 'Bot ' + token, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  }
  function validMessage(message, record) {
    return discordId.test(message?.id ?? '') && message.channel_id === channelId && message.author?.id === botId &&
      message.content === record.content && message.mention_everyone === false &&
      Array.isArray(message.mentions) && message.mentions.length === 0 && Array.isArray(message.mention_roles) && message.mention_roles.length === 0;
  }
  async function reconcile(record) {
    try {
      const response = await request('/channels/' + channelId + '/messages' + (record.messageId ? '/' + record.messageId : '?limit=50'));
      if (!response.ok) return record;
      const data = await response.json();
      const message = record.messageId ? data : Array.isArray(data) && data.find(item => String(item.nonce) === record.nonce && validMessage(item, record));
      if (validMessage(message, record)) {
        Object.assign(record, { status: 'verified', messageId: message.id, verifiedAt: new Date(now()).toISOString(),
          url: `https://discord.com/channels/${guildId}/${channelId}/${message.id}` });
        save(record);
      }
    } catch { /* Preserve uncertain/sent status; never resend automatically. */ }
    return record;
  }
  return {
    preview: validate,
    receipt(id) { return read(id); },
    async publish(input, id) {
      const preview = validate(input);
      path(id);
      if (input.sha256 !== preview.sha256) fail(409, 'Texten motsvarar inte den godkända förhandsgranskningen.');
      if (locks.has(id)) fail(409, 'Publiceringen behandlas redan. Kontrollera kvittot.');
      locks.add(id);
      try {
        const old = read(id);
        if (old) {
          if (old.sha256 !== preview.sha256) fail(409, 'Publiceringsnyckeln har redan använts för en annan text.');
          if (old.status === 'publishing') { old.status = 'uncertain'; save(old); }
          return ['sent', 'uncertain'].includes(old.status) ? await reconcile(old) : old;
        }
        // Destination and identity are checked using the actual bot credential.
        // No arbitrary channel IDs, mentions, attachments or webhook URLs accepted.
        let identity, channel;
        try {
          const me = await request('/users/@me');
          if (!me.ok) throw new Error();
          identity = await me.json();
          const target = await request('/channels/' + channelId);
          if (!target.ok) throw new Error();
          channel = await target.json();
        } catch { fail(503, 'Bot och mottagare kunde inte verifieras. Inget skickades.'); }
        if (identity.id !== botId || identity.bot !== true || channel.id !== channelId || channel.guild_id !== guildId || channel.type !== 0) {
          fail(503, 'Bot eller mottagare motsvarar inte konfigurationen. Inget skickades.');
        }
        const record = { id, ...preview, nonce: digest(environment + ':' + id).slice(0, 24), status: 'publishing', createdAt: new Date(now()).toISOString() };
        save(record, true);
        try {
          const response = await request('/channels/' + channelId + '/messages', { method: 'POST', body: JSON.stringify({
            content: record.content, nonce: record.nonce, enforce_nonce: true, allowed_mentions: { parse: [], users: [], roles: [] },
          }) });
          if (response.ok) {
            const message = await response.json();
            if (!validMessage(message, record)) throw new Error();
            Object.assign(record, { status: 'sent', messageId: message.id });
          } else record.status = response.status >= 400 && response.status < 500 ? 'failed' : 'uncertain';
        } catch { record.status = 'uncertain'; }
        save(record);
        return record.status === 'sent' ? await reconcile(record) : record;
      } finally { locks.delete(id); }
    },
  };
}
