import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { login, readPosition, safeOption } from './tabony.mjs';
import { subscribe } from './worker.mjs';

const config = { matchId: '3270', username: 'NationsBot20', opponent: 'Kayser', play: true };
const allPlayers = [config.opponent, config.username];
const snapshot = (number, player, options = []) => ({
  replaying: false, players: allPlayers, accepted: allPlayers, move_number: number,
  state: {
    game_over: 0, move_number: number, next_move_player: player,
    next_move_choice: 'Draft which nation?', next_move_options: options,
    players: { Kayser: {}, NationsBot20: {} },
  },
});

test('only the configured live match and offered safe options can be played', () => {
  const message = snapshot(2, config.username, ['Greece', 'Resign', 'UNDO']);
  const position = readPosition(message, config);
  assert.equal(safeOption(position, 'Greece'), true);
  for (const value of ['Egypt', 'Resign', 'UNDO']) assert.equal(safeOption(position, value), false);
  assert.equal(readPosition({ ...message, replaying: true }, config), null);
  assert.throws(() => readPosition({ ...message, players: ['AnotherPlayer', config.username] }, config));
});

test('Tabony login uses form CSRF and verifies the session identity', async t => {
  const replies = [
    new Response('<input name="csrfmiddlewaretoken" value="maskedToken">', {
      headers: { 'Set-Cookie': 'csrftoken=csrfCookie; Secure' },
    }),
    new Response(null, { status: 302, headers: { 'Set-Cookie': 'sessionid=sessionCookie; Secure' } }),
    new Response('<script id="username" type="application/json">"NationsBot20"</script>'),
  ];
  const request = t.mock.method(globalThis, 'fetch', async () => replies.shift());
  const password = 'fake-test-password';
  assert.equal(await login({ ...config, password }), 'sessionid=sessionCookie');
  const [url, init] = request.mock.calls[1].arguments;
  assert.equal(url, 'https://games.tabony.net/accounts/login/');
  assert.equal(init.headers.Cookie, 'csrftoken=csrfCookie');
  assert.equal(init.body.get('csrfmiddlewaretoken'), 'maskedToken');
  assert.equal(init.body.get('password'), password);
  assert.equal(request.mock.calls[2].arguments[1].headers.Cookie, 'sessionid=sessionCookie');
});

test('managed matches verify all participants in three- through five-player games', () => {
  for (const count of [3, 4, 5]) {
    const players = [...allPlayers, ...Array.from({ length: count - 2 }, (_, n) => 'Rival' + n)];
    const message = snapshot(2, config.username, ['Confirm']);
    message.players = players; message.accepted = players;
    message.state.players = Object.fromEntries(players.map(name => [name, {}]));
    assert.equal(readPosition(message, { ...config, players }), message.state);
    assert.throws(() => readPosition({ ...message, players: [...players.slice(0, -1), 'Unknown'] }, { ...config, players }));
  }
});

test('observer, opponent turns, repeated states and an unconfirmed send cannot play', async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent = [];
    constructor() { super(); socket = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const moves = { pending: null, async save(value) { this.pending = value; } };
  const botTurn = snapshot(3, config.username, ['Greece']);
  const feed = async state => {
    socket.emit('message', JSON.stringify(state));
    await setImmediate();
  };
  let done = subscribe({ ...config, play: false }, null, moves, FakeSocket);
  await feed(botTurn);
  assert.deepEqual(socket.sent, []);
  socket.close();
  await done;

  done = subscribe(config, 'sessionid=fake', moves, FakeSocket);
  await feed(snapshot(2, config.opponent));
  assert.deepEqual(socket.sent, []);
  await feed(botTurn);
  await feed(botTurn);
  assert.deepEqual(socket.sent, [{ move: 'Greece' }]);
  assert.equal(moves.pending, 3);
  socket.close();
  await done;

  done = subscribe(config, 'sessionid=fake', moves, FakeSocket);
  await feed(botTurn);
  assert.deepEqual(socket.sent, []);
  await feed(snapshot(4, config.username, ['Confirm']));
  assert.deepEqual(socket.sent, [{ move: 'Confirm' }]);
  assert.equal(moves.pending, 4);
  socket.close();
  await done;
});
