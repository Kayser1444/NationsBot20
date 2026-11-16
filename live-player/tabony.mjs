export const origin = 'https://games.tabony.net';
const loginUrl = `${origin}/accounts/login/`;

export class StopPlayer extends Error {}

function sessionPair(response, name) {
  const pair = response.headers.getSetCookie()
    .map(cookie => cookie.split(';', 1)[0])
    .find(cookie => cookie.startsWith(`${name}=`));
  return pair && pair.length > name.length + 1 ? pair : null;
}

function request(url, init = {}) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12_000), ...init });
}

export async function login({ username, password, matchId }) {
  const next = matchId ? `/nations/${matchId}/` : '/nations/matches/mine/';
  const formPage = await request(loginUrl);
  if (!formPage.ok) throw new StopPlayer(`Tabony login page returned HTTP ${formPage.status}.`);
  const csrfCookie = sessionPair(formPage, 'csrftoken');
  const token = (await formPage.text()).match(/name="csrfmiddlewaretoken"\s+value="([A-Za-z0-9]+)"/)?.[1];
  if (!csrfCookie || !token) throw new StopPlayer('Could not read the Tabony login form.');
  const response = await request(loginUrl, {
    method: 'POST',
    headers: { Cookie: csrfCookie, Origin: origin, Referer: loginUrl },
    body: new URLSearchParams({ username, password, csrfmiddlewaretoken: token, next }),
  });
  const session = sessionPair(response, 'sessionid');
  await response.body?.cancel();
  if (response.status !== 302 || !session) throw new StopPlayer('Tabony did not accept the account login. Check its credentials.');
  if (!matchId) return session; // The managed worker verifies identity against the signed-in listing on each poll.

  const matchPage = await request(`${origin}/nations/${matchId}/`, { headers: { Cookie: session } });
  const identity = (await matchPage.text()).match(/<script id="username" type="application\/json">([^<]+)<\/script>/)?.[1];
  if (!matchPage.ok || !identity || JSON.parse(identity) !== username) {
    throw new StopPlayer('Tabony did not confirm the bot account on the match page.');
  }
  return session;
}

export function readPosition(message, config) {
  const state = message?.state;
  if (message?.replaying !== false || !state) return null;
  const expected = config.players ?? [config.username, config.opponent];
  if (!Array.isArray(message.players) || message.players.length !== expected.length ||
      expected.length < 2 || expected.length > 5 || new Set(message.players).size !== expected.length ||
      !expected.every(name => message.players.includes(name))) {
    throw new StopPlayer('The live match does not have the configured players.');
  }
  if (!Array.isArray(message.accepted) || !expected.every(name => message.accepted.includes(name))) return null;
  if (![0, 1, false, true].includes(state.game_over) ||
      (!state.game_over && !expected.includes(state.next_move_player)) ||
      !Number.isSafeInteger(message.move_number) || message.move_number < 0 ||
      state.move_number !== message.move_number ||
      (state.next_move_player === config.username &&
        (!expected.every(name => state.players?.[name]) || typeof state.next_move_choice !== 'string' ||
         !Array.isArray(state.next_move_options) ||
         !state.next_move_options.every(option => typeof option === 'string')))) {
    throw new StopPlayer('The live match position has an unexpected format.');
  }
  return state;
}

export function safeOption(state, option) {
  return typeof option === 'string' && !/^(undo|resign)$/i.test(option) &&
    state.next_move_options.includes(option);
}
