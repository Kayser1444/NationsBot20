import { randomBytes } from 'node:crypto';

const SESSION_COOKIE = '__Host-nations-admin';
const LOGIN_COOKIE = '__Host-nations-login';
const random = () => randomBytes(32).toString('hex');
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
function cookies(req) {
  const result = Object.create(null);
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const split = part.indexOf('=');
    if (split > 0) result[part.slice(0, split).trim()] = part.slice(split + 1).trim();
  }
  return result;
}

export function adminSettings(env = process.env) {
  if (env.NATIONS_ADMIN_ENABLED !== '1') return null;
  const settings = { origin: env.NATIONS_ADMIN_ORIGIN, clientId: env.NATIONS_DISCORD_CLIENT_ID,
    clientSecret: env.NATIONS_DISCORD_CLIENT_SECRET, ownerId: env.NATIONS_ADMIN_OWNER_ID };
  validate(settings);
  return settings;
}
function validate(settings) {
  const url = new URL(settings.origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !/^\d{17,20}$/.test(settings.clientId ?? '') || !/^\d{17,20}$/.test(settings.ownerId ?? '') ||
      typeof settings.clientSecret !== 'string' || !settings.clientSecret.trim()) throw new Error('Invalid admin OAuth settings.');
  return url.origin;
}

export function createDiscordAuth(settings, { fetcher = fetch, now = Date.now, sessionSeconds = 3600 } = {}) {
  const origin = validate(settings), redirectUri = origin + '/auth/callback';
  const logins = new Map(), sessions = new Map();
  function purge() {
    for (const [id, value] of logins) if (value.expires <= now()) logins.delete(id);
    for (const [id, value] of sessions) if (value.expires <= now()) sessions.delete(id);
  }
  function session(req) {
    purge();
    const value = sessions.get(cookies(req)[SESSION_COOKIE]);
    return value?.userId === settings.ownerId ? value : null;
  }
  function fail(res, status, message) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(message);
  }
  function redirect(res, location, setCookie) {
    res.writeHead(303, { location, 'set-cookie': setCookie, 'cache-control': 'no-store' }); res.end();
  }
  return {
    origin,
    session,
    close() { logins.clear(); sessions.clear(); },
    async handle(req, res, url) {
      purge();
      if (req.method === 'GET' && url.pathname === '/auth/login') {
        if (logins.size >= 50) { fail(res, 429, 'Too many sign-in attempts. Please try again later.'); return true; }
        const state = random();
        // Replace this browser's pending attempt rather than accumulating it.
        logins.delete(cookies(req)[LOGIN_COOKIE]);
        logins.set(state, { expires: now() + 300000 });
        const authorize = new URL('https://discord.com/oauth2/authorize');
        authorize.search = new URLSearchParams({ client_id: settings.clientId, response_type: 'code',
          scope: 'identify', redirect_uri: redirectUri, state }).toString();
        redirect(res, authorize.href, cookie(LOGIN_COOKIE, state, 300)); return true;
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        const state = url.searchParams.get('state'), browserState = cookies(req)[LOGIN_COOKIE];
        const pending = logins.get(state);
        if (!state || state !== browserState || !pending || pending.expires <= now()) {
          fail(res, 400, 'Sign-in expired or invalid. Start again from the sign-in page.'); return true;
        }
        logins.delete(state); // One-use and bound to the initiating browser.
        res.setHeader('set-cookie', cookie(LOGIN_COOKIE, '', 0));
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code || code.length > 2048) {
          fail(res, 400, 'Discord sign-in was not completed.'); return true;
        }
        try {
          const response = await fetcher('https://discord.com/api/v10/oauth2/token', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret,
              grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
          });
          if (!response.ok) throw new Error('OAuth exchange failed.');
          const token = await response.json();
          if (typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer' ||
              !token.scope?.split(' ').includes('identify')) throw new Error('Invalid OAuth response.');
          const identity = await fetcher('https://discord.com/api/v10/users/@me', {
            redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: 'Bearer ' + token.access_token },
          });
          if (!identity.ok) throw new Error('Identity lookup failed.');
          const user = await identity.json();
          if (user.id !== settings.ownerId || user.bot) {
            fail(res, 403, 'This console is restricted to the NationsBot owner.'); return true;
          }
          // Tokens and user profiles are never persisted or sent to the browser.
          sessions.delete(cookies(req)[SESSION_COOKIE]);
          while (sessions.size >= 10) sessions.delete(sessions.keys().next().value);
          const id = random();
          sessions.set(id, { userId: user.id, csrf: random(), expires: now() + sessionSeconds * 1000 });
          redirect(res, '/', [cookie(LOGIN_COOKIE, '', 0), cookie(SESSION_COOKIE, id, sessionSeconds)]);
        } catch { fail(res, 502, 'Discord sign-in could not be verified. Please try again.'); }
        return true;
      }
      if (url.pathname === '/auth/logout') {
        const active = session(req);
        if (req.method !== 'POST' || !active || req.headers.origin !== origin || req.headers['x-nations-token'] !== active.csrf) {
          fail(res, 403, 'Reload the console before signing out.'); return true;
        }
        sessions.delete(cookies(req)[SESSION_COOKIE]);
        redirect(res, '/', cookie(SESSION_COOKIE, '', 0)); return true;
      }
      return false;
    },
  };
}
