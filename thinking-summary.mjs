function duration(minutes) {
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return [days ? `${days} d` : '', days || hours ? `${hours} h` : '', `${minutes % 60} min`].filter(Boolean).join(' ');
}

// Sum before rounding so many short moves still contribute to the total.
export function thinkingSummary(journal, now = Date.now()) {
  const games = new Map();
  const gameFor = id => {
    if (!games.has(id)) games.set(id, { matchId: id, tracking: Boolean(journal.tracking[id]), over: Boolean(journal.turns[id]?.over), suspended: Boolean(journal.turns[id]?.suspended), players: new Map() });
    return games.get(id);
  };
  const add = (id, player, durationMs, partial, ongoing = false) => {
    if (!player) return;
    const game = gameFor(id);
    if (!game.players.has(player)) game.players.set(player, { player, durationMs: 0, partial: false, ongoing: false });
    const total = game.players.get(player);
    total.durationMs += Math.max(0, durationMs);
    total.partial ||= Boolean(partial);
    total.ongoing ||= ongoing;
  };
  for (const id of Object.keys(journal.tracking)) gameFor(id);
  for (const record of journal.records) add(record.matchId, record.player, record.durationMs, record.partial);
  for (const [id, turn] of Object.entries(journal.turns)) {
    if (turn.trackedAt != null && !turn.over && !turn.suspended && journal.tracking[id]) add(id, turn.player, now - turn.trackedAt, turn.partial, true);
  }
  return [...games.values()].map(game => ({ ...game, players: [...game.players.values()]
    .map(({ durationMs, ...player }) => ({ ...player, minutes: Math.floor(durationMs / 60000), duration: duration(Math.floor(durationMs / 60000)) }))
    .sort((a, b) => b.minutes - a.minutes || a.player.localeCompare(b.player, 'sv')) }));
}
