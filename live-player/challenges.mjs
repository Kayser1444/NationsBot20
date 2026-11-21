import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { origin } from './tabony.mjs';

export const challengeNamePattern = /^[A-Za-z0-9_]{1,20}$/;
const day = time => new Date(time).toISOString().slice(0, 10);

export function challengeStore(directory, now = Date.now) {
  const path = join(directory, 'player-challenges.json');
  let entries;
  try { entries = JSON.parse(readFileSync(path, 'utf8')).filter(entry => entry.status !== 'preparing'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  function save(next) {
    writeFileSync(path + '.tmp', JSON.stringify(next), { mode: 0o600 });
    renameSync(path + '.tmp', path);
    entries = next;
  }
  function update(entry, changes) {
    save(entries.map(item => item.key === entry.key ? { ...item, ...changes } : item));
  }
  function check(username, matchId) {
    const games = entries.filter(entry => entry.username === username);
    const active = games.find(entry => entry.status !== 'closed');
    if (active) {
      if (matchId && active.matchId === matchId && active.status === 'inviting') return { entry: active };
      return { result: active.matchId ? 'active' : 'pending', matchId: active.matchId };
    }
    if (games.filter(entry => entry.date === day(now())).length >= 5) return { result: 'limit' };
    return {};
  }
  return {
    check,
    reserve(bot, username, { matchId = null, discordUserId = null } = {}) {
      const discordChallenge = discordUserId && entries.find(entry => entry.discordUserId === discordUserId && entry.status !== 'closed');
      if (discordChallenge) {
        return { result: discordChallenge.matchId ? 'active' : 'pending', matchId: discordChallenge.matchId };
      }
      const checked = check(username, matchId);
      if (checked.result || checked.entry) return checked;
      const date = day(now());
      const entry = { key: randomUUID(), bot, username, matchId, date, status: matchId ? 'inviting' : 'preparing',
        ...(discordUserId ? { discordUserId } : {}) };
      save([...entries.filter(item => item.status !== 'closed' || item.date === date), entry]);
      return { entry };
    },
    discard(entry) { save(entries.filter(item => item.key !== entry.key)); },
    submitting(entry) { update(entry, { status: 'creating', date: day(now()) }); },
    confirm(entry, matchId) {
      if (entries.some(item => item.key === entry.key && item.status !== 'closed')) update(entry, { matchId, status: 'open' });
    },
    authorize(bot, match) {
      return match.playerCount === 2 && match.players.length === 2 && match.players.includes(bot) &&
        entries.some(entry => entry.bot === bot && entry.matchId === match.id && entry.status !== 'closed' &&
          match.players.includes(entry.username));
    },
    reconcile(bot, matches) {
      let changed = false;
      const byId = new Map(matches.map(match => [match.id, match]));
      const next = entries.map(entry => {
        if (entry.bot !== bot || entry.status === 'closed') return entry;
        const match = entry.matchId ? byId.get(entry.matchId)
          : matches.find(game => game.title === challengeTitle(entry));
        if (!match) return entry;
        if (match.section === 'Completed:' || (match.section === 'Open:' && !match.players.includes(entry.username))) {
          changed = true;
          return { ...entry, matchId: match.id, status: 'closed' };
        }
        if (!match.invitation && match.players.includes(entry.username) && entry.status !== 'open') {
          changed = true;
          return { ...entry, matchId: match.id, status: 'open' };
        }
        return entry;
      });
      if (changed) save(next);
    },
    finished(bot, matchId) {
      const entry = entries.find(item => item.bot === bot && item.matchId === matchId && item.status !== 'closed');
      if (entry) update(entry, { status: 'closed' });
    },
  };
}

function challengeTitle(entry) {
  return `NationsBot challenge - ${entry.key}`;
}

export function challengeOptions(bot, entry, pick = randomInt) {
  // Match the setting pools in experiments/nations-rl/mixed_rules.py.
  const growth = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4][pick(10)];
  const form = new URLSearchParams({
    title: challengeTitle(entry), player_count: '2', growth_resources: String(growth),
    player1: bot, player2: entry.username, extra_draft_nations: String(pick(3)),
    resource_remainder_tiebreaker: 'on',
  });
  if (pick(10) < 7) form.set('weighted_card_draw', 'on');
  if (pick(2)) form.set('korea_nerf', 'on');
  if (pick(2)) form.set('lincoln_nerf', 'on');
  return form;
}

export async function createTabonyChallenge(bot, entry, session, beforeConfirm, { fetcher = fetch, baseUrl = origin } = {}) {
  const create = '/nations/create/', confirm = '/nations/create/confirm/';
  const signal = AbortSignal.timeout(16000);
  let csrfCookie;
  async function request(path, body) {
    const response = await fetcher(baseUrl + path, {
      redirect: 'manual', signal, method: body ? 'POST' : 'GET', body,
      headers: { Cookie: [session, csrfCookie].filter(Boolean).join('; '), Origin: baseUrl, Referer: baseUrl + path },
    });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('csrftoken='));
    if (cookie) csrfCookie = cookie.split(';', 1)[0];
    return response;
  }
  function tokenFor(html, path) {
    const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g)
      ?.find(markup => markup.includes(`action="${path}"`));
    const token = form?.match(/name="csrfmiddlewaretoken"\s+value="([A-Za-z0-9]+)"/)?.[1];
    if (!token || !csrfCookie) throw new Error('Tabony challenge form could not be verified.');
    return token;
  }
  const page = await request(create);
  const html = await page.text();
  const identity = html.match(/<span class="navbar-text[^"]*">Welcome, ([^<]+)!<\/span>/)?.[1];
  if (!page.ok || identity !== bot) {
    throw new Error('Tabony challenge account could not be verified.');
  }
  const options = challengeOptions(bot, entry);
  options.set('csrfmiddlewaretoken', tokenFor(html, create));
  const review = await request(create, options);
  if (review.status === 200) {
    if ((await review.text()).includes('No player with that username.')) return { result: 'unknown' };
    throw new Error('Tabony did not validate the challenge form.');
  }
  await review.body?.cancel();
  if (review.status !== 302 || review.headers.get('location') !== confirm) throw new Error('Tabony did not open the challenge review.');
  const confirmation = await request(confirm);
  const details = await confirmation.text();
  if (!confirmation.ok || !details.includes(`>${challengeTitle(entry)}</span>`) ||
      !details.includes(`>Player 1: <span class="fw-bold">${bot}</span>`) ||
      !details.includes(`>Player 2: <span class="fw-bold">${entry.username}</span>`)) {
    throw new Error('Tabony challenge review did not match the request.');
  }
  const body = new URLSearchParams({ csrfmiddlewaretoken: tokenFor(details, confirm) });
  if (!beforeConfirm()) return { result: 'unavailable' };
  const created = await request(confirm, body);
  await created.body?.cancel();
  const location = created.headers.get('location');
  if (created.status === 403 || (created.status === 302 && location === create)) return { result: 'unavailable' };
  const matchId = location?.match(/^\/nations\/(\d{1,10})\/$/)?.[1];
  if (created.status !== 302 || !matchId) throw new Error('Tabony did not confirm the new challenge.');
  return { result: 'created', matchId };
}
