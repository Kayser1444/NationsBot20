import cards from './card-index.json' with { type: 'json' };

export function chatQuestion(chat, players, bot) {
  if (!players.includes(chat?.player) || chat.player === bot ||
      typeof chat.message !== 'string' || chat.message.length > 510) return null;
  const message = chat.message.trim();
  const addressed = message.match(/^(@?)([a-z0-9_]+)[,:]?\s+(.+)$/is);
  const toBot = addressed?.[2].toLowerCase() === bot.toLowerCase();
  if (!toBot && (players.length > 2 || message.startsWith('@'))) return null;
  const question = toBot ? addressed[3].trim() : message;
  return question.length >= 5 && /[?？]\s*$/.test(question) ? question : null;
}

export function publicMatchContext({ state, log }, players, bot, asker) {
  const nameOf = id => typeof id === 'string' ? cards[id]?.name ?? id : null;
  const board = slots => Object.fromEntries(Object.entries(slots ?? {}).map(([slot, id]) => [slot, nameOf(id)]));
  return {
    bot, asker, decision: state.move_number, round: state.round, phase: state.phase,
    nextPlayer: state.next_move_player, turnOrder: state.player_order,
    event: nameOf(state.event), war: nameOf(state.war), warStrength: state.war_value,
    architects: state.architects, turmoil: state.turmoil, market: board(state.progress_board),
    players: Object.fromEntries(players.map(name => {
      const player = state.players?.[name] ?? {};
      return [name, {
        nation: player.nation, score: player.score, resources: player.resources, production: player.production,
        passed: player.passed, workers: player.workers, board: board(player.slots),
        cardCounts: Object.fromEntries(Object.entries(player.cards ?? {}).map(([id, card]) =>
          [nameOf(id), { deployed: card?.deployed, architects: card?.architects, markers: card?.markers }])),
      }];
    })),
    recentGameLog: typeof log === 'string' ? log.slice(-1600) : '',
  };
}

export function createTabonyQuestionClient(env = process.env, fetcher = fetch) {
  if (!env.NATIONS_TABONY_QUESTION_URL) return undefined;
  const url = new URL(env.NATIONS_TABONY_QUESTION_URL);
  if (url.protocol !== 'http:' || !url.hostname.endsWith('.railway.internal') || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !/^[a-f0-9]{64}$/.test(env.NATIONS_PLAYER_CONTROL_TOKEN ?? '')) {
    throw new Error('Invalid private Tabony question configuration.');
  }
  return async ({ asker, question, matchContext, signal }) => {
    const response = await fetcher(new URL('/question', url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(125_000)]),
      headers: { authorization: `Bearer ${env.NATIONS_PLAYER_CONTROL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ asker, question, matchContext }),
    });
    if (!response.ok) throw new Error('Tabony question service unavailable.');
    return (await response.json()).reply;
  };
}

export function chatLine(text) {
  if (typeof text !== 'string') return '';
  const line = text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  const chars = Array.from(line);
  return chars.length > 255 ? chars.slice(0, 254).join('').trimEnd() + '…' : line;
}
