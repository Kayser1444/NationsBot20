// The browser uses the existing owner session. Only this server holds the
// credential for the separate player service on Railway's private network.
export function createPlayerAdmin({ env = process.env, fetcher = fetch } = {}) {
  if (!env.NATIONS_PLAYER_CONTROL_URL || !env.NATIONS_PLAYER_CONTROL_TOKEN) return null;
  const origin = new URL(env.NATIONS_PLAYER_CONTROL_URL);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      !/^[a-f0-9]{64}$/.test(env.NATIONS_PLAYER_CONTROL_TOKEN)) throw new Error('Invalid player control configuration.');
  return async (action, input, actor) => {
    if (!['status', 'settings', 'poll', 'match-model', 'account'].includes(action)) throw new Error('Invalid player control action.');
    let response;
    try {
      response = await fetcher(new URL('/' + action, origin), {
        method: action === 'status' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(action === 'poll' ? 65000 : 25000),
        headers: { authorization: `Bearer ${env.NATIONS_PLAYER_CONTROL_TOKEN}`, 'content-type': 'application/json' },
        ...(action === 'settings' ? { body: JSON.stringify({ settings: input.settings, revision: input.revision, actor }) } : {}),
        ...(action === 'match-model' ? { body: JSON.stringify({ accountId: input?.accountId, matchId: input?.matchId, modelId: input?.modelId, previousModel: input?.previousModel, actor }) } : {}),
        ...(action === 'account' ? { body: JSON.stringify({
          action: input?.action, accountId: input?.accountId, username: input?.username, password: input?.password,
          defaultModel: input?.defaultModel, matchIds: input?.matchIds, actor,
        }) } : {}),
      });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error([400, 409, 413, 415].includes(response.status) ? body.error : 'Player service could not complete the request.'), { status: [400, 409, 413, 415].includes(response.status) ? response.status : 503 });
      return body;
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(new Error(action === 'match-model'
        ? 'Could not confirm the model change. Refresh the match list to check.'
        : 'Player service could not confirm the request. Refresh to check the saved state.'), { status: 503 });
    }
  };
}
