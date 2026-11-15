import WebSocket from 'ws';
import { origin, StopPlayer } from './tabony.mjs';

const decode = text => text.replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => String.fromCodePoint(Math.min(0x10ffff, n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parseMyMatches(html, username) {
  const identity = html.match(/<span class="navbar-text[^"]*">Welcome, ([^<]+)!<\/span>/)?.[1];
  if (!identity || decode(identity) !== username || !html.includes('<h1>Your Nations Matches</h1>')) throw new StopPlayer('The signed-in match listing could not be verified.');
  const matches = [];
  let section = '';
  for (const part of html.split(/(?=<h2>|<div class="card my-2")/)) {
    if (part.startsWith('<h2>')) { section = part.match(/^<h2>([^<]*)/)?.[1]?.trim() ?? ''; continue; }
    if (!part.startsWith('<div class="card my-2"') || section === 'Completed:') continue;
    const id = part.match(/href="\/nations\/(\d+)\/"/)?.[1];
    const count = Number(part.match(/Type:\s*<span[^>]*>(\d+)-Player/)?.[1]);
    const names = [...(part.match(/Players:([\s\S]*?)<\/div>/)?.[1] ?? '').matchAll(/<span[^>]*>([^<]*)<\/span>/g)]
      .map(m => decode(m[1]).trim().replace(/ \(invited\)$/, ''));
    const title = decode(part.match(/Title:\s*<span[^>]*>([^<]*)<\/span>/)?.[1] ?? '');
    if (!id || count < 2 || count > 6 || !names.includes(username) || names.some(name => !/^[a-zA-Z0-9_]{1,20}$/.test(name))) throw new Error('Unexpected match listing format.');
    matches.push({ id, title, playerCount: count, players: names, invitation: section === 'Invitations:', section });
  }
  if (!matches.length && !/<li>\s*None\.\s*<\/li>/.test(html)) throw new Error('The match listing has no recognizable entries.');
  return matches;
}

export async function discoverAccountMatches(session, username, fetcher = fetch) {
  const response = await fetcher(`${origin}/nations/matches/mine/`, {
    headers: { Cookie: session }, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if ([301, 302, 303, 401, 403].includes(response.status)) { await response.body?.cancel(); throw new StopPlayer('The player session needs a new login.'); }
  if (!response.ok) throw new Error(`Match listing returned HTTP ${response.status}.`);
  return parseMyMatches(await response.text(), username);
}

export function isAuthorized(match, settings, username) {
  return settings.playerCounts.includes(match.playerCount) && match.players.includes(username) &&
    new Set(match.players).size === match.players.length && match.players.length <= match.playerCount &&
    match.players.some(name => name !== username) &&
    match.players.every(name => name === username || settings.authorizedPlayers.includes(name));
}

export function acceptInvitation(match, config, session, Socket = WebSocket) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(`wss://games.tabony.net/ws/nations/${match.id}/`, {
      origin, headers: { Cookie: session }, handshakeTimeout: 12000, maxPayload: 4 * 1024 * 1024,
    });
    let sent = false, settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error('Invitation acceptance could not be confirmed.')), 15000);
    socket.on('open', () => socket.send('null'));
    socket.on('error', () => finish(new Error('Invitation connection failed.')));
    socket.on('close', () => { if (!settled) finish(new Error('Invitation connection closed before confirmation.')); });
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes);
        if (!Array.isArray(message.players) || message.replaying !== false) return;
        if (message.players.length !== match.players.length || !message.players.every(name => match.players.includes(name)) ||
            !isAuthorized(match, config.settings(), config.username)) throw new Error('Invitation participants changed. Poll again.');
        if (!Array.isArray(message.accepted)) throw new Error('Unexpected invitation acceptance state.');
        if (message.accepted.includes(config.username)) { finish(); return; }
        const settings = config.settings();
        if (!settings.playEnabled || !settings.autoAccept) throw new Error('Invitation acceptance is paused.');
        if (!sent) { sent = true; socket.send(JSON.stringify({ join: settings.growthResources })); }
      } catch (error) { finish(error); }
    });
  });
}
