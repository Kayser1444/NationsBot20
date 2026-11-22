"""Policy-guided rollouts through both players' moves and the current settlement."""
from collections import Counter, deque
from dataclasses import dataclass
from heapq import heappop, heappush, nsmallest
from itertools import count
from random import Random
from time import perf_counter

from nations_lookahead import SearchBoundary, SearchBudget, lock_hidden_information
from nations_microsearch import ADMIN, ranked_choices
from nations_move_safety import safe_architect_options, with_move_options


class RoundSettled(Exception):
    def __init__(self, state):
        self.state = state


@dataclass(frozen=True)
class RoundLine:
    moves: tuple
    greedy_from: int
    value: tuple
    sampled_draw: bool


@dataclass
class RoundSearchMemory:
    round_number: int = 0
    replay: tuple = ()
    lines: tuple = ()
    branches: tuple = ()

    def reuse(self, round_number, replay):
        size = len(self.replay)
        if self.round_number != round_number or replay[:size] != self.replay:
            return [], []
        played = replay[size:]
        skip = len(played)
        lines = [RoundLine(line.moves[skip:], max(0, line.greedy_from - skip), line.value, False)
                 for line in self.lines if len(line.moves) > skip and line.moves[:skip] == played]
        branches = [(moves[skip:], tuple((index - skip, loss) for index, loss in deviations if index >= skip))
                    for moves, deviations in self.branches if len(moves) > skip and moves[:skip] == played]
        return lines, branches


def rollout_round(replay, root, prefix, predict, branch, deadline, *, observe):
    """Replay once per line, with a common public-card sample for Victoria Falls."""
    from nations import Match
    from nations.exceptions import GameOver

    entered = False
    owner = root['next_move_player']
    path = []
    revealed = set()
    remaining = []
    sampled = False

    def check():
        if perf_counter() >= deadline:
            raise SearchBudget()

    class RoundMatch(Match):
        def progress_phase(self):
            super().progress_phase()
            revealed.update(card.abbr for row in self.progress_board for card in row if card is not None)

        def draw_cards(self, number):
            nonlocal sampled
            if not entered:
                drawn = super().draw_cards(number)
                revealed.update(card.abbr for card in drawn)
                return drawn
            sampled = True
            drawn = remaining[:number]
            del remaining[:number]
            return drawn

        def resolution_phase(self):
            try:
                super().resolution_phase()
            except GameOver:
                if not entered:
                    raise
            if entered:
                check()
                if len(path) < len(prefix) or self.round_number != root['round']:
                    raise ValueError('Rollout did not execute its branch in the current round')
                state = observe(self)
                state['sampled_draw'] = sampled
                state['rollout_moves'] = tuple(path)
                if self.game_over:
                    ordered = sorted(self.players, key=lambda p: (
                        -p.score(), -p.resource_remainder() if self.resource_remainder_tiebreaker else 0))
                    scores = {p.name: p.score() for p in ordered}
                    state['final_winner'] = ordered[0].name
                    state['final_margin'] = scores[owner] - scores[next(name for name in scores if name != owner)]
                raise RoundSettled(state)

        def undo(self, invalid=False):
            if entered:
                raise SearchBoundary('engine rejected rollout move')
            raise ValueError('Replay prefix no longer reproduces the current game')

    def choose(prompt, options, _undo):
        nonlocal entered
        check()
        actor = match.current_player.name
        guarded = safe_architect_options(match, prompt, options)
        legal = {str(option): option for option in guarded if str(option) not in ADMIN}
        if not entered:
            if ((match.move_number, actor, prompt) != (root['move_number'], owner, root['next_move_choice'])
                    or tuple(root['next_move_options']) not in (tuple(map(str, options)), tuple(map(str, guarded)))):
                raise ValueError('Replay did not reproduce the round search root')
            # The catalogue and all revealed cards are public. Sort to remove
            # the actual deck ordering before sampling with a public seed.
            age = (match.round_number + 1) // 2
            if age == 4:
                catalogue = match.initial_progress_card_order[age]
                remaining.extend(sorted((card for card in catalogue if card.abbr not in revealed),
                                        key=lambda card: card.abbr))
                Random(f'{root["round"]}/{root["move_number"]}/{owner}').shuffle(remaining)
            lock_hidden_information(match)
            entered = True

        if not legal:
            raise SearchBoundary('no legal rollout choice')
        if len(path) < len(prefix):
            move = prefix[len(path)]
        elif len(legal) == 1:
            move = next(iter(legal))
        else:
            prediction = predict(with_move_options(observe(match), guarded))
            choices = ranked_choices(prompt, legal, prediction, all_moves=True)
            if not choices:
                raise SearchBoundary('no legal rollout choice')
            move = choices[0]
            if actor == owner and not sampled:
                branch(tuple(path), choices, prediction)
        if move not in legal:
            raise ValueError(f'Round rollout found an unavailable move at {prompt}')
        path.append(move)
        return legal[move]

    match = RoundMatch(replay=replay, move_getter=choose)
    try:
        match.play()
    except RoundSettled as settled:
        return settled.state
    raise ValueError('Rollout did not reach current round settlement')


def search_round(match, state, options, predict, direct, *, value_score, observe, memory=None,
                 max_lines=4, max_attempts=12, seconds=.35, hard_seconds=3, on_override=None, rollout=None):
    """Require settled comparisons from distinct root choices before overriding."""
    started = perf_counter()
    deadline = started + hard_seconds
    owner, prompt = state['next_move_player'], state['next_move_choice']
    legal = tuple(str(option) for option in options if str(option) not in ADMIN)
    choices = ranked_choices(prompt, legal, direct, all_moves=True)
    stats = Counter()
    if len(choices) < 2:
        return next(iter(choices), None), stats, 0.

    replay = match.get_replay()
    rollout = rollout or rollout_round
    transcript = tuple(replay.splitlines())
    cached, pending = memory.reuse(state['round'], transcript) if memory is not None else ([], [])
    queue, root_branches, queued, visited = [], deque(), set(), set()
    indices = count()
    candidate_roots, lines = set(), []
    known_rollouts = set()
    best = None
    direct_path = (choices[0],)
    stats['searched'] = 1

    def push(path, deviations):
        if path not in queued:
            queued.add(path)
            heappush(queue, (sum(loss for _, loss in deviations), len(path), next(indices), path, deviations))

    def enqueue(path, choices, prediction, deviations):
        preference = {row['move']: row.get('policy_gap', rank)
                      for rank, row in enumerate(prediction['moves'])}
        top = preference.get(choices[0], 0.)
        for rank, move in enumerate(choices[1:], start=1):
            loss = max(0., preference.get(move, top + rank) - top)
            route = path + (move,)
            costs = (*deviations, (len(path), loss))
            push(route, costs)
            if not path:
                root_branches.append((route, costs))

    def record(line, reused=False):
        nonlocal best
        lines.append(line)
        candidate_roots.add(line.moves[0])
        stats['settled_lines'] += 1
        stats['reused_settled_lines' if reused else 'new_settled_lines'] += 1
        stats['sampled_draw_lines'] += line.sampled_draw
        if best is None or line.value > best.value:
            best = line

    def follow(path, deviations, *, baseline=False):
        visited.add(path)
        stats['attempted_lines'] += 1
        try:
            settled = rollout(replay, state, path, predict,
                              lambda prefix, order, prediction: enqueue(prefix, order, prediction, deviations),
                              deadline, observe=observe)
        except SearchBoundary as error:
            stats[f'blocked: {error}'] += 1
            return None
        return RoundLine(settled['rollout_moves'], 0 if baseline else len(path),
                         value_score(settled, owner), settled['sampled_draw'])

    enqueue((), choices, direct, ())
    for path, deviations in pending:
        if path[0] in choices:
            push(path, deviations)
    cached = [line for line in cached if line.moves[0] in choices]
    direct_line = next((line for line in cached if not line.greedy_from and line.moves[0] == choices[0]), None)
    try:
        if direct_line is not None:
            cached.remove(direct_line)
            record(direct_line, reused=True)
            stats['reused_direct_line'] += 1
        else:
            direct_line = follow(direct_path, (), baseline=True)
            if direct_line is not None:
                record(direct_line)
        if direct_line is not None:
            for line in cached:
                record(line, reused=True)
            for line in lines:
                # Any prefix at or beyond the last deviation replays the
                # same greedy suffix, so its settlement is already known.
                known_rollouts.update(line.moves[:i] for i in range(max(1, line.greedy_from), len(line.moves) + 1))
            while stats['attempted_lines'] < max_attempts:
                if len(candidate_roots) < 2:
                    if not root_branches:
                        break
                    path, deviations = root_branches.popleft()
                else:
                    if stats['new_settled_lines'] >= max_lines or perf_counter() - started >= seconds or not queue:
                        break
                    _, _, _, path, deviations = heappop(queue)
                if path in visited or path in known_rollouts:
                    continue
                line = follow(path, deviations)
                if line is not None:
                    record(line)
                    known_rollouts.update(line.moves[:i] for i in range(line.greedy_from, len(line.moves) + 1))
    except SearchBudget:
        stats['hard_budget'] += 1

    stats['compared'] = int(len(candidate_roots) >= 2)
    if stats['compared'] and best.sampled_draw:
        stats['victoria_falls_fallback'] += 1
    best_move = best.moves[0] if stats['compared'] and not best.sampled_draw else choices[0]
    if on_override is not None and best_move != choices[0] and not direct_line.sampled_draw:
        on_override(direct_line, best)
    if memory is not None:
        memory.round_number, memory.replay = state['round'], transcript
        memory.lines = tuple(line for line in lines if not line.sampled_draw)
        eligible = (entry for entry in queue if entry[3] not in visited and entry[3] not in known_rollouts)
        memory.branches = tuple((path, deviations) for _, _, _, path, deviations in nsmallest(256, eligible))
    stats['changed_move'] = int(best_move != choices[0])
    return best_move, stats, (perf_counter() - started) * 1000
