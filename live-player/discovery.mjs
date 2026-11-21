import WebSocket from 'ws';
import { origin, StopPlayer } from './tabony.mjs';

const decode = text => text.replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => String.fromCodePoint(Math.min(0x10ffff, n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parseMyMatches(html, username, { includeCompleted = false, archived = false } = {}) {
  const identity = html.match(/<span class="navbar-text[^"]*">Welcome, ([^<]+)!<\/span>/)?.[1];
  if (!identity || decode(identity) !== username || !html.includes(`<h1>Your ${archived ? 'Archived ' : ''}Nations Matches</h1>`)) throw new StopPlayer('The signed-in match listing could not be verified.');
  const matches = [];
  let section = '';
  for (const part of html.split(/(?=<h2>|<div class="card my-2")/)) {
    if (part.startsWith('<h2>')) { section = part.match(/^<h2>([^<]*)/)?.[1]?.trim() ?? ''; continue; }
    if (!part.startsWith('<div class="card my-2"') || section === 'Completed:' && !includeCompleted) continue;
    const id = part.match(/href="\/nations\/(\d+)\/"/)?.[1];
    const count = Number(part.match(/Type:\s*<span[^>]*>(\d+)-Player/)?.[1]);
    const names = [...(part.match(/Players:([\s\S]*?)<\/div>/)?.[1] ?? '').matchAll(/<span[^>]*>([^<]*)<\/span>/g)]
      .map(m => decode(m[1]).trim().replace(/ \(invited\)$/, ''));
    const title = decode(part.match(/Title:\s*<span[^>]*>([^<]*)<\/span>/)?.[1] ?? '');
    if (!id || count < 2 || count > 6 || !names.includes(username) || names.some(name => !/^[a-zA-Z0-9_]{1,20}$/.test(name))) throw new Error('Unexpected match listing format.');
    const rules = part.match(/Type:\s*<span[^>]*>[^<]+<\/span>,\s*\(([^)]*)\)/)?.[1]?.split(', ');
    matches.push({ id, title, playerCount: count, players: names, invitation: section === 'Invitations:', section,
      weightedCardDraw: rules?.includes('Card Draw') ?? false });
  }
  if (!matches.length && !/<li>\s*None\.\s*<\/li>/.test(html)) throw new Error('The match listing has no recognizable entries.');
  return matches;
}

export async function discoverAccountMatches(session, username, fetcher = fetch, archived = false, includeCompleted = false) {
  const path = archived ? '/nations/archive/mine/' : '/nations/matches/mine/';
  const response = await fetcher(origin + path, {
    headers: { Cookie: session }, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if ([301, 302, 303, 401, 403].includes(response.status)) { await response.body?.cancel(); throw new StopPlayer('The player session needs a new login.'); }
  if (!response.ok) throw new Error(`Match listing returned HTTP ${response.status}.`);
  return parseMyMatches(await response.text(), username, { archived, includeCompleted });
}

export function hasEligiblePlayer(match, settings, username) {
  return match.players.some(name => name !== username && (settings.playMode === 'open' || settings.authorizedPlayers.includes(name)));
}

export function isAuthorized(match, settings, username) {
  return settings.playerCounts.includes(match.playerCount) && match.players.includes(username) &&
    new Set(match.players).size === match.players.length && match.players.length <= match.playerCount &&
    hasEligiblePlayer(match, settings, username);
}

export function acceptInvitation(match, config, session, Socket = WebSocket) {
  return respondToInvitation(match, config, session, Socket, 'acceptance');
}

export function declineInvitation(match, config, session, Socket = WebSocket) {
  return respondToInvitation(match, config, session, Socket, 'decline');
}

function respondToInvitation(match, config, session, Socket, action) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(`wss://games.tabony.net/ws/nations/${match.id}/`, {
      origin, headers: { Cookie: session }, handshakeTimeout: 12000, maxPayload: 4 * 1024 * 1024,
    });
    let sent = false, settled = false, live, chatSent = false, chatConfirmed = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      config.signal?.removeEventListener('abort', abort);
      socket.close();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error(`Invitation ${action} was stopped.`));
    const timer = setTimeout(() => finish(new Error(`Invitation ${action} could not be confirmed.`)), 15000);
    socket.on('open', () => socket.send('null'));
    socket.on('error', () => finish(new Error('Invitation connection failed.')));
    socket.on('close', () => { if (!settled) finish(new Error('Invitation connection closed before confirmation.')); });
    const matchesChat = chat => chat?.player === config.username && chat.message === config.declineMessage;
    function decline() {
      if (!live || sent) return;
      if (!live.players.includes(config.username) || live.state || live.accepted.includes(config.username) ||
          !config.shouldDecline({ ...match, players: live.players })) {
        finish(null, false);
        return;
      }
      if (config.declineMessage && !chatConfirmed) {
        if (!chatSent) { chatSent = true; socket.send(JSON.stringify({ chat: config.declineMessage })); }
        return;
      }
      sent = true;
      socket.send(JSON.stringify({ decline: config.username }));
    }
    socket.on('message', bytes => {
      if (settled) return;
      try {
        const message = JSON.parse(bytes);
        if (action === 'decline' && config.declineMessage &&
            (matchesChat(message.chat) || (Array.isArray(message.chat_log) && message.chat_log.some(matchesChat)))) {
          chatConfirmed = true;
          decline();
        }
        if (!Array.isArray(message.players) || message.replaying !== false) return;
        if (!Array.isArray(message.accepted)) throw new Error('Unexpected invitation acceptance state.');
        if (action === 'decline') {
          if (!message.players.includes(config.username)) {
            finish(null, sent);
            return;
          }
          live = message;
          decline();
          return;
        }
        if (message.players.length !== match.players.length || new Set(message.players).size !== match.players.length ||
            !message.players.every(name => match.players.includes(name)) ||
            !(config.authorize?.(match) ?? isAuthorized(match, config.settings(), config.username))) throw new Error('Invitation participants changed. Poll again.');
        if (message.accepted.includes(config.username)) {
          const lobbyStarted = sent && match.players.length === match.playerCount &&
            match.players.every(name => message.accepted.includes(name));
          finish(null, { lobbyStarted });
          return;
        }
        const settings = config.settings();
        if (!settings.playEnabled || !settings.autoAccept || config.canPlay?.() === false) throw new Error('Invitation acceptance is paused.');
        if (!sent) {
          if (config.beforeJoin?.(message) === false) { finish(null, false); return; }
          sent = true;
          socket.send(JSON.stringify({ join: settings.growthResources }));
        }
      } catch (error) { finish(error); }
    });
    config.signal?.addEventListener('abort', abort, { once: true });
    if (config.signal?.aborted) abort();
  });
}
