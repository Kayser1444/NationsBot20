// Read-only observer model. Disconnects preserve the last known player.
export function observe(previous, message, username) {
  if (message.replaying !== false || !message.state ||
      ![true, false, 0, 1].includes(message.state.game_over) ||
      (!message.state.game_over && typeof message.state.next_move_player !== 'string')) {
    return { state: previous, event: null };
  }
  const state = {
    player: message.state.next_move_player ?? null,
    decision: message.state.next_move_choice ?? null,
    move: message.move_number ?? message.state.move_number ?? null,
    over: Boolean(message.state.game_over),
  };
  const event = !previous ? 'INITIAL SNAPSHOT' :
    !previous.over && state.over ? 'GAME COMPLETE' :
    username && !state.over && state.player === username &&
      (previous.player !== username || previous.over) ? 'YOUR TURN' : null;
  return { state, event };
}
