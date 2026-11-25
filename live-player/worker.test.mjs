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

test('the worker vetoes the final architect when every wonder slot is blocked', async () => {
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
  const model = {
    playerPolicies: { '2': 'rl-' + 'a'.repeat(24) },
    experimental: { rank: state => ({ moves: [{ move: state.next_move_options[0] }] }) },
  };
  const done = subscribe({ ...config, model }, 'sessionid=fake', moves, FakeSocket);
  try {
    const blocked = { W1: 'Sbr', W2: 'Sbr2', W3: 'SwOs', W4: 'GrBk', W5: 'CGH' };
    const offer = async (number, { nation = 'Rome', wonder = 'StLb', completed = 1,
      slots = blocked, prompt = 'Hire [Architect] for free?', options = ['Yes', 'No'] } = {}) => {
      const message = snapshot(number, config.username, options);
      message.state.next_move_choice = prompt;
      message.state.players[config.username] = {
        nation, slots: { ...slots, Hire: wonder }, cards: { [wonder]: { architects: completed } },
      };
      const sent = socket.sent.length;
      socket.emit('message', JSON.stringify(message));
      await setImmediate();
      assert.equal(socket.sent.length, sent + 1);
      return socket.sent.at(-1);
    };
    assert.deepEqual(await offer(10), { move: 'No' });
    assert.deepEqual(await offer(11, { completed: 0, prompt: 'Hire 1 [Architect] for free?' }), { move: 'Yes' });
    assert.deepEqual(await offer(12, { wonder: 'WcTw', slots: { ...blocked, W5: 'Orc' } }), { move: 'Yes' });
    assert.deepEqual(await offer(20, { completed: 0, slots: { ...blocked, W5: 'WcTw' } }), { move: 'Yes' });
    assert.deepEqual(await offer(21, { nation: 'China' }), { move: 'Yes' });
    assert.deepEqual(await offer(22, { nation: 'China', slots: { ...blocked, W6: 'Vsv' },
      prompt: 'Which action?', options: ['Special of "Qin Dynasty"', 'Hire', 'Hire from "Source"', 'Pass'] }), { move: 'Pass' });
    assert.deepEqual(await offer(23, { prompt: 'Hire 1 [Architect] for free?' }), { move: 'No' });
    assert.deepEqual(await offer(24, { nation: 'China', prompt: 'Which action?',
      options: ['Special of "Qin Dynasty"', 'Pass'] }), { move: 'Special of "Qin Dynasty"' });
  } finally {
    socket.close();
    await done;
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

test('switching the model during the journal write changes the unsent move, then waits for confirmation', async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent = [];
    constructor() { super(); socket = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const model = (suffix, move) => ({ playerPolicies: { '2': 'rl-' + suffix.repeat(24) },
    experimental: { rank: () => ({ moves: [{ move }] }) } });
  let selected = model('a', 'Greece');
  let finishWrite, beginWrite;
  const writing = new Promise(resolve => { beginWrite = resolve; });
  const moves = { pending: null, async save(next) {
    this.pending = next;
    if (next === 3) await new Promise(resolve => { finishWrite = resolve; beginWrite(); });
  } };
  const done = subscribe({ ...config, getModel: () => selected }, 'sessionid=fake', moves, FakeSocket);
  const turn = JSON.stringify(snapshot(3, config.username, ['Greece', 'Egypt']));
  socket.emit('message', turn);
  await writing;
  assert.deepEqual(socket.sent, []);
  selected = model('b', 'Egypt');
  finishWrite();
  await setImmediate();
  assert.deepEqual(socket.sent, [{ move: 'Egypt' }]);
  selected = model('a', 'Greece');
  socket.emit('message', turn);
  await setImmediate();
  assert.deepEqual(socket.sent, [{ move: 'Egypt' }]);
  assert.equal(moves.pending, 3);
  socket.close();
  await done;
});

test('only live participants can ask the bot and chat work leaves moves free to run', async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent = [];
    constructor() { super(); socket = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const players = [...allPlayers, 'AnotherPlayer'];
  const moves = { pending: null, async save(next) { this.pending = next; } };
  const requests = [];
  let answer;
  const askQuestion = request => {
    requests.push(request);
    return new Promise(resolve => { answer = resolve; });
  };
  const done = subscribe({ ...config, players, askQuestion }, 'sessionid=fake', moves, FakeSocket);
  const feed = async payload => {
    socket.emit('message', JSON.stringify(payload));
    await setImmediate();
  };
  const chat = (player, message) => ({ player, message, timestamp: '2026-11-25T10:00:00Z' });
  const position = (decision, nextPlayer, options) => {
    const frame = snapshot(decision, nextPlayer, options);
    frame.players = frame.accepted = players;
    frame.state.players.AnotherPlayer = { resources: { '[Military]': 8 }, privateNotes: 'never send' };
    frame.log = 'AnotherPlayer gained 2 Military.';
    return frame;
  };
  const question = '@NationsBot20, Who has the most Military?';
  try {
    await feed({ chat: chat('Kayser', question) });
    await feed(position(1, 'Kayser'));
    await feed({ chat_log: [chat('Kayser', question)] });
    await feed({ chat: chat('Spectator', question) });
    await feed({ chat: chat(config.username, question) });
    await feed({ chat: chat('Kayser', 'Who has the most Military?') });
    assert.equal(requests.length, 0);

    await feed({ chat: chat('Kayser', question) });
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.question, 'Who has the most Military?');
    assert.equal(request.matchContext.players.AnotherPlayer.resources['[Military]'], 8);
    assert.equal(request.matchContext.recentGameLog, 'AnotherPlayer gained 2 Military.');
    assert.equal(JSON.stringify(request.matchContext).includes('never send'), false);
    await feed({ chat: chat('Kayser', question) });
    await feed(position(2, config.username, ['Greece']));
    assert.deepEqual(socket.sent, [{ move: 'Greece' }]);

    answer('AnotherPlayer leads.\n' + 'a'.repeat(260));
    await setImmediate();
    assert.equal(socket.sent[1].chat.length, 255);
    assert.match(socket.sent[1].chat, /^AnotherPlayer leads\. a+…$/);
    assert.equal(requests.length, 1);
  } finally {
    socket.close();
    await done;
  }
});
