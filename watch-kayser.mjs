// Public spectator observer with optional Discord turn alerts. No game mutations.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { observe } from './turn-state.mjs';
import { webhookUrl, verifyDiscordDestination, sendDiscord, turnMessage } from './discord.mjs';
import { discoverPublicMatches, addDiscoveredMatches } from './match-discovery.mjs';
import { Outbox } from './outbox.mjs';
import { liveSnapshot } from './live-snapshot.mjs';
import { ServiceStatus } from './service-status.mjs';
import { startDashboard } from './dashboard.mjs';
import { adminSettings, createDiscordAuth } from './admin-auth.mjs';
import { EventLog } from './event-log.mjs';
import { validateSubscriptions, readSubscriptions, saveSubscriptions, readPreviousNationsName, readDmPreference, saveDmPreference, readUserLocale, saveUserLocale, readLanguageOverride, readBotLanguage, saveLanguagePreference } from './subscriptions.mjs';
import { text } from './language.mjs';
import { PlayerCache } from './player-cache.mjs';
import { startDiscordBot } from './discord-bot.mjs';
import { botDelivery } from './bot-delivery.mjs';
import { SmTableCache } from './sm-table.mjs';
import { readBannedUsers, isUserBanned, setUserBan, recipients, subscriptionEntries, addSubscriber, removeSubscriber } from './subscriptions.mjs';
import { adminUsers } from './admin-users.mjs';
const args = process.argv.slice(2);
const profile = args.includes('--config') ? args[args.indexOf('--config') + 1] : 'kayser.json';
if (!['kayser.json', 'friends.json'].includes(profile)) throw new Error('Unknown configuration profile.');
const configPath = process.env.NATIONS_CONFIG_DIR ? join(process.env.NATIONS_CONFIG_DIR, profile) : fileURLToPath(new URL(profile, import.meta.url));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
let subscriptions = readSubscriptions(configPath);
const seconds = args.includes('--seconds') ? Number(args[args.indexOf('--seconds') + 1]) : 0;
if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid duration');
const matches = config.matches.map(match => ({ ...match, state: null, status: 'connecting', backoff: 1000 }));
const events = [];
const discoveryIntervalMs = 5 * 60 * 1000;
// These requests return full snapshots, so keep idle checks infrequent.
const snapshotCheckIntervalMs = 5 * 60 * 1000;
const gameSilenceTimeoutMs = 2 * snapshotCheckIntervalMs;
const discoveryAbort = new AbortController();
let discoveryTimer, discoveryStatus = 'checking public match lists';
let discoveryBusy = false, discoveryAgain = false, lastDiscovery = null;
let discordUrl = null;
if (profile !== 'friends.json' && process.env.NATIONS_DISCORD_WEBHOOK) {
  try {
    discordUrl = webhookUrl(process.env.NATIONS_DISCORD_WEBHOOK);
  }
  catch (error) { console.error(error.message); process.exit(1); }
}
const transport = profile === 'friends.json'
  ? (process.env.NATIONS_DISCORD_BOT_TOKEN ? botDelivery(process.env.NATIONS_DISCORD_BOT_TOKEN, config.discord) : null)
  : (discordUrl ? {
    verify: signal => verifyDiscordDestination(discordUrl, config.discord, { signal }),
    send: (payload, signal) => sendDiscord(discordUrl, payload, { attempts: 1, signal }),
  } : null);
let delivery = transport ? 'enabled' : 'not configured';
const deliveryAbort = new AbortController();
const dataDirectory = process.env.NATIONS_DATA_DIR || fileURLToPath(new URL('./.data/', import.meta.url));
const log = new EventLog(join(dataDirectory, profile.replace('.json', '.log')));
const sm = profile === 'friends.json' ? new SmTableCache(JSON.parse(readFileSync(new URL('./sm-season.json', import.meta.url), 'utf8')), {
  path: join(dataDirectory, 'sm-table-cache.json'), report: (message, level) => log.add(message, level),
}) : null;
if (sm) {
  for (const pinned of sm.matches) {
    let match = matches.find(m => m.id === pinned.id);
    if (!match) { match = { ...pinned, state: null, status: 'connecting', backoff: 1000 }; matches.push(match); }
    Object.assign(match, pinned, { smLocked: true });
  }
}
const playerCache = new PlayerCache(join(dataDirectory, 'player-names.json'), (message, level) => log.add(message, level));
let outbox = null, outboxTimer;
try {
  if (transport) {
    outbox = new Outbox(join(dataDirectory, profile.replace('.json', '-outbox.json')), { guildId: config.discord.guildId, channelId: config.discord.channelId });
    addDiscoveredMatches(matches, outbox.data.jobs.filter(job => !sm?.has(job.matchId)).map(job => ({ id: job.matchId, title: job.title, players: [job.player] })));
  }
} catch {
  console.error('Could not open the saved outbox. Check its file and destination; no alerts were sent.');
  process.exit(1);
}
let stopped = false, deadline, dashboard = null, subscriptionTimer, lastDelivery = null, bot = null;
let botState = process.env.NATIONS_DISCORD_BOT_TOKEN && profile === 'friends.json' ? 'Ansluter' : 'Inte konfigurerad';
const serviceStatus = transport ? new ServiceStatus(async (payload, signal) => {
  await transport.verify(signal);
  await transport.send(payload, signal);
}, message => log.add(message, 'error')) : null;
const shown = new Map();
let shownDiscovery, shownDelivery;
const gameLabel = match => `${match.title || 'Parti'} (${match.id ?? match.matchId})`;
function show() {
  if (shownDelivery !== delivery) {
    shownDelivery = delivery;
    if (delivery.startsWith('last alert confirmed')) lastDelivery = new Date().toISOString();
    else if (/RETRY|BLOCKED|STOPPED/.test(delivery)) log.add(delivery, 'error');
  }
  if (shownDiscovery !== discoveryStatus) {
    shownDiscovery = discoveryStatus;
    if (discoveryStatus.startsWith('FAILED')) log.add('Matchsökningen misslyckades. Befintliga partier fortsätter bevakas.', 'error');
  }
  for (const m of matches) {
    const before = shown.get(m.id);
    const current = { status: m.status, player: m.state?.player, over: m.state?.over };
    if (before && before.player !== current.player && current.player) log.add(`${current.player} har turen i ${gameLabel(m)}`);
    if (before && !before.over && current.over) log.add(`Parti avslutat: ${gameLabel(m)}`);
    if (before?.status !== current.status) {
      if (current.status === 'connected') log.add(`Ansluten till ${gameLabel(m)}`);
      else if (/disconnected|error/.test(current.status)) log.add(`Anslutningen till ${gameLabel(m)} avbröts. Återansluter.`, 'error');
    }
    shown.set(m.id, current);
  }
}
function snapshot() {
  return {
    now: new Date().toISOString(), stopped, discordEnabled: Boolean(transport),
    pending: outbox?.data.jobs.length ?? 0, blocked: outbox?.data.jobs.filter(job => job.blocked).length ?? 0,
    lastDelivery, lastDiscovery,
    botState,
    users: adminUsers(JSON.parse(readFileSync(configPath, 'utf8')), subscriptions, matches, outbox?.data.jobs),
    bannedUsers: Object.entries(readBannedUsers(configPath)).map(([userId, ban]) => ({ userId, ...ban })),
    playerNames: playerCache.names, playerNamesUpdatedAt: playerCache.updatedAt,
    subscribers: subscriptionEntries(subscriptions).map(([username, userId]) => ({ username, userId, matches: matches.filter(m => !m.finished && m.players?.includes(username)).length })),
    matches: matches.map(m => ({ id: m.id, title: m.title, player: m.state?.player ?? null, over: Boolean(m.finished), connected: m.status === 'connected' })),
    events: log.error ? [...log.entries, { time: new Date().toISOString(), level: 'error', message: log.error }] : log.entries,
  };
}
function applySubscriptions(selected) {
  if (JSON.stringify(subscriptions) === JSON.stringify(selected)) return;
  const previous = subscriptions;
  try { outbox?.updateSubscriptions(previous, selected); }
  catch { delivery = 'STOPPED: could not update the outbox'; show(); stop(); throw new Error('Utkorgen kunde inte sparas. Bevakningen har stoppats.'); }
  subscriptions = selected;
  for (const name of Object.keys(previous)) if (!Object.hasOwn(selected, name)) log.add(`Prenumeration avslutad: ${name}`);
  for (const [name, id] of Object.entries(selected)) if (previous[name] !== id) log.add(`Prenumeration sparad: ${name}`);
  for (const m of [...matches]) {
    if (!m.smLocked && m.players && !m.players.some(name => Object.hasOwn(selected, name))) {
      m.removed = true; const socket = m.socket; m.socket = null;
      clearTimeout(m.retry); clearInterval(m.heartbeat); socket?.close();
      matches.splice(matches.indexOf(m), 1); shown.delete(m.id);
      log.add(`Bevakning avslutad: ${gameLabel(m)} (inga prenumeranter)`);
    } else if (m.state) {
      try { outbox?.observe(m, m.state, recipients(selected, m.state.player)); }
      catch { stop(); throw new Error('Utkorgen kunde inte sparas. Bevakningen har stoppats.'); }
    }
  }
  void refreshMatches();
}
function stop() {
  if (stopped) return serviceStatus?.stopPromise;
  stopped = true; clearTimeout(deadline);
  clearInterval(subscriptionTimer); dashboard?.close();
  bot?.close();
  log.add('Bevakningen stängs av.');
  clearTimeout(outboxTimer); deliveryAbort.abort();
  clearTimeout(discoveryTimer); discoveryAbort.abort();
  for (const m of matches) {
    clearTimeout(m.retry); clearInterval(m.heartbeat); m.socket?.close();
  }
  return serviceStatus?.stop();
}
async function flushOutbox() {
  if (!outbox || stopped) return;
  try {
    await outbox.flush({
      signal: deliveryAbort.signal,
      validate: async job => {
        if (!recipients(subscriptions, job.player).includes(job.userId) || isUserBanned(configPath, job.userId)) return false;
        const m = matches.find(match => match.id === job.matchId);
        // Wait for this run's initial snapshot; persisted state alone is insufficient.
        if (!m?.state) throw new Error('Waiting for a fresh game snapshot.');
        if (m.state.over || m.state.player !== job.player) return false;
        if (profile !== 'friends.json' || !readDmPreference(configPath, job.userId)) await transport.verify(deliveryAbort.signal);
        const state = await liveSnapshot(job.matchId, { signal: deliveryAbort.signal });
        return !state.over && state.player === job.player;
      },
      send: job => {
        if (stopped || !recipients(subscriptions, job.player).includes(job.userId) || isUserBanned(configPath, job.userId) || !outbox.current(job)) throw new Error('Subscription changed before delivery.');
        const payload = turnMessage(job.player, { id: job.matchId, title: job.title }, job.userId,
          profile === 'friends.json' ? readBotLanguage(configPath, job.userId) : 'sv-SE');
        return profile === 'friends.json'
          ? transport.sendReminder(payload, job.userId, id => readDmPreference(configPath, id), deliveryAbort.signal, () => !stopped && recipients(subscriptions, job.player).includes(job.userId) && !isUserBanned(configPath, job.userId) && outbox.current(job))
          : transport.send(payload, deliveryAbort.signal);
      },
      report: async (status, job) => {
        delivery = job ? status.replace(`for ${job.matchId}`, `för ${gameLabel(job)}`) : status; show();
        if (status.startsWith('last alert confirmed') && job) {
          let name = null;
          try { name = await bot?.resolveDisplayName(job.userId); } catch { /* Log the ID if Discord cannot resolve a name. */ }
          const recipient = name ? name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : `Discord-ID ${job.userId}`;
          log.add(`Discord-påminnelse levererad till ${recipient} för ${gameLabel(job)}`);
        }
      },
    });
  } catch {
    delivery = 'STOPPED: could not save the outbox; check available disk space and file permissions';
    show(); stop(); process.exitCode = 1;
  }
  if (!stopped) outboxTimer = setTimeout(flushOutbox, 1000);
}
async function refreshMatches() {
  if (stopped) return;
  clearTimeout(discoveryTimer);
  if (discoveryBusy) { discoveryAgain = true; return; }
  discoveryBusy = true;
  try {
    const publicMatches = await discoverPublicMatches({ signal: discoveryAbort.signal });
    if (stopped) return;
    playerCache.update(publicMatches);
    const discovered = publicMatches.filter(m => !sm?.has(m.id) && m.players.some(name => Object.hasOwn(subscriptions, name)));
    const added = addDiscoveredMatches(matches, discovered);
    lastDiscovery = new Date().toISOString();
    discoveryStatus = `${new Date().toISOString()} | ${discovered.length} matching games | ${added.length} added`;
    for (const m of added) {
      log.add(`Nytt parti upptäckt: ${gameLabel(m)}`);
      events.push(`${new Date().toISOString()} | NEW MATCH | https://games.tabony.net/nations/${m.id}/`);
      if (events.length > 10) events.shift();
      connect(m);
    }
  } catch (error) {
    if (stopped) return;
    discoveryStatus = `FAILED: ${error.message}; existing games remain monitored; retry in 5 minutes`;
  } finally { discoveryBusy = false; }
  if (!stopped) {
    show();
    discoveryTimer = setTimeout(refreshMatches, discoveryAgain ? 0 : discoveryIntervalMs);
    discoveryAgain = false;
  }
}
function connect(m) {
  if (stopped || m.finished || m.removed) return;
  clearTimeout(m.retry); clearInterval(m.heartbeat); m.socket?.close();
  if (m.smLocked) sm.connection(m.id, false);
  m.status = 'connecting'; show();
  const socket = new WebSocket(`wss://games.tabony.net/ws/nations/${m.id}/`);
  m.socket = socket; m.lastResponse = Date.now();
  socket.addEventListener('open', () => {
    if (stopped || m.socket !== socket) return;
    m.status = 'connected, awaiting snapshot'; show(); socket.send('null');
  });
  socket.addEventListener('message', ({ data }) => {
    if (stopped || m.socket !== socket) return;
    m.lastResponse = Date.now();
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (m.smLocked) sm.update(m.id, message);
    const result = observe(m.state, message, config.username);
    if (result.state === m.state) return;
    const previous = m.state;
    m.state = result.state; m.status = 'connected'; m.backoff = 1000;
    if (m.state.over) {
      m.finished = true;
      m.status = 'complete, monitoring stopped';
      clearTimeout(m.retry); clearInterval(m.heartbeat);
      // Invalidate before closing so the close handler cannot reconnect.
      m.socket = null;
      socket.close();
    }
    const player = m.state.player;
    const subscribed = Object.hasOwn(subscriptions, player);
    if (outbox) {
      try { outbox.observe(m, m.state, recipients(subscriptions, player)); }
      catch {
        delivery = 'STOPPED: could not save the outbox; no new alert sent';
        show(); stop(); process.exitCode = 1; return;
      }
    }
    const freshTurn = previous && !m.state.over && subscribed && (previous.player !== player || previous.over);
    const pendingOnStartup = !previous && transport && !m.state.over && subscribed;
    if (freshTurn || result.event === 'GAME COMPLETE' || pendingOnStartup) {
      events.push(`${new Date().toISOString()} | ${pendingOnStartup ? 'TURN PENDING ON STARTUP' : freshTurn ? 'TURN: ' + player : result.event} | https://games.tabony.net/nations/${m.id}/`);
      if (events.length > 10) events.shift();
      if (freshTurn || pendingOnStartup) {
        process.stdout.write('\x07');
      }
    }
    if (!previous || previous.player !== m.state.player || previous.move !== m.state.move || previous.over !== m.state.over) show();
  });
  socket.addEventListener('error', () => {
    if (stopped || m.socket !== socket) return;
    if (m.smLocked) sm.connection(m.id, false);
    m.status = 'connection error'; show(); socket.close();
  });
  socket.addEventListener('close', () => {
    if (stopped || m.socket !== socket) return;
    if (m.smLocked) sm.connection(m.id, false);
    clearInterval(m.heartbeat);
    m.status = `disconnected, retry in ${m.backoff / 1000}s`; show();
    m.retry = setTimeout(() => connect(m), m.backoff);
    m.backoff = Math.min(m.backoff * 2, 30000);
  });
  m.heartbeat = setInterval(() => {
    if (Date.now() - m.lastResponse > gameSilenceTimeoutMs) connect(m);
    else if (socket.readyState === WebSocket.OPEN) socket.send('null');
  }, snapshotCheckIntervalMs);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (seconds > 0) deadline = setTimeout(stop, seconds * 1000);
if (!args.includes('--no-dashboard')) {
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : profile === 'friends.json' ? 24680 : 24681;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid dashboard port.');
  try {
    dashboard = await startDashboard({ port, snapshot,
      auth: args.includes('--cloud-admin') ? createDiscordAuth(adminSettings(), {
        sessionPath: join(dataDirectory, 'admin-sessions.json'),
        // Cloud admin already trusts Railway's HTTPS ingress. X-Real-IP must
        // be replaced by that ingress; never expose this port via a TCP proxy.
        clientAddress: req => isIP(req.headers['x-real-ip'] ?? '') ? req.headers['x-real-ip'] : req.socket.remoteAddress,
      }) : null,
      subscribe: async (username, userId) => {
        if (stopped) throw new Error('Bevakningen är stoppad.');
        const next = addSubscriber(subscriptions, username, userId);
        applySubscriptions(saveSubscriptions(configPath, next));
      },
      unsubscribe: async (username, userId) => {
        if (stopped) throw new Error('Bevakningen är stoppad.');
        if (!userId && recipients(subscriptions, username).length > 1) throw new Error('Ange Discord-ID för prenumerationen som ska avslutas.');
        const next = removeSubscriber(subscriptions, userId || recipients(subscriptions, username)[0]);
        applySubscriptions(saveSubscriptions(configPath, next));
      },
      setBan: async (userId, enabled) => {
        if (stopped) throw new Error('Bevakningen är stoppad.');
        applySubscriptions(setUserBan(configPath, userId, enabled));
        log.add(`${enabled ? 'Discord-användare spärrad' : 'Spärr hävd'}: ${userId}`);
      },
    });
    if (stopped) dashboard.close();
    else log.add(`Statusfönster: ${dashboard.url} · Ctrl+C stoppar bevakningen.`);
  } catch {
    if (args.includes('--cloud-admin')) console.error('Admin console disabled: could not safely load sessions or open its port. Reminders continue.');
    else {
      console.error('Could not open the local status window. Another instance may already be running.');
      process.exit(1);
    }
  }
}
if (!stopped) {
log.add(`Bevakningen startar för ${Object.keys(subscriptions).join(', ') || 'inga prenumeranter'}.`);
if (profile === 'friends.json' && !transport) log.add('Bot-token saknas. Partier bevakas men inga Discord-meddelanden kan skickas.', 'error');
subscriptionTimer = setInterval(() => {
  try { applySubscriptions(readSubscriptions(configPath)); }
  catch (error) { log.add(error.message, 'error'); }
}, 5000);
for (const m of matches) connect(m);
void refreshMatches();
if (outbox) outboxTimer = setTimeout(flushOutbox, 0);
void serviceStatus?.start();
if (process.env.NATIONS_DISCORD_BOT_TOKEN && profile === 'friends.json' && !args.includes('--no-bot-commands')) {
  bot = startDiscordBot({ token: process.env.NATIONS_DISCORD_BOT_TOKEN,
    guildId: config.discord.guildId, channelId: config.discord.channelId,
    report: (message, level) => log.add(message, level), onState: state => { botState = state; },
    service: {
      getSmTable: (div, userId, language) => sm.reply(div, userId, readSubscriptions(configPath), language ?? readBotLanguage(configPath, userId)),
      isBanned: userId => isUserBanned(configPath, userId),
      getSubscriptions: () => readSubscriptions(configPath),
      getPreviousName: userId => readPreviousNationsName(configPath, userId),
      getDm: userId => readDmPreference(configPath, userId),
      getLocale: userId => readUserLocale(configPath, userId),
      getLanguageOverride: userId => readLanguageOverride(configPath, userId),
      setLanguage: (userId, language) => saveLanguagePreference(configPath, userId, language),
      captureLocale: (userId, locale) => saveUserLocale(configPath, userId, locale),
      checkDm: userId => transport.sendReminder({
        content: text(readBotLanguage(configPath, userId), 'dmControl'),
        allowed_mentions: { parse: [] },
      }, userId, () => true, AbortSignal.any([deliveryAbort.signal, AbortSignal.timeout(10000)]),
      () => !stopped && !isUserBanned(configPath, userId) && readDmPreference(configPath, userId)),
      setDm: (userId, enabled) => {
        if (stopped) throw new Error('Bevakningen är stoppad.');
        saveDmPreference(configPath, userId, enabled);
        try { outbox?.retryUser(userId); } catch { stop(); throw new Error('Utkorgen kunde inte sparas.'); }
        log.add(`DM-inställning sparad: ${enabled ? 'på' : 'av'}`);
      },
      getNames: () => playerCache.names,
      commit: selected => {
        if (stopped) throw new Error('Bevakningen är stoppad.');
        applySubscriptions(saveSubscriptions(configPath, selected));
      },
      getStatus: (username, userId) => {
        const monitored = matches.filter(m => !m.finished && m.players?.includes(username));
        return { discordEnabled: Boolean(transport), blocked: outbox?.data.jobs.some(job => job.userId === userId && job.blocked),
          matches: monitored.length, matchList: monitored.map(m => ({ id: m.id, title: m.title, player: m.state?.player ?? null, connected: m.status === 'connected' })) };
      },
    },
  });
}
}
