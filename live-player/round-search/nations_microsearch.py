"""Local, replay-backed search up to a rival decision or round resolution."""

from collections import Counter, deque
from dataclasses import dataclass
from heapq import heappop, heappush
from itertools import count
from sys import _getframe
from time import perf_counter

from nations_lookahead import SearchBoundary, SearchBudget, lock_hidden_information
from nations_move_safety import safe_architect_options, with_move_options


ADMIN = {'UNDO', 'Resign'}
MAIN = 'Which action?'
COMPLETE = 'Complete the turn?'
RESOLVED_HANDOFFS = {'opponent turn', 'round resolution'}
HANDOFFS = {
    'opponent turn', 'opponent choice', 'round resolution', 'unrevealed event',
    'unrevealed progress cards', 'random outcome', 'hidden seed',
}


@dataclass
class Position:
    state: dict
    choices: tuple = ()
    main_actions: int = 0
    boundary: str | None = None
    key: tuple | None = None
    stock: tuple = ()
    final_win: bool | None = None
    final_margin: int | None = None
    remaining_main_actions: dict | None = None


class InspectPosition(Exception):
    def __init__(self, position):
        self.position = position


class SearchPositions:
    """Share reached positions and retain every observed incoming move."""

    def __init__(self, match, state, choices):
        self.exact = {}
        self.edges = [[]]
        self.observations = {(): (0, state.get('move_number', 0))}
        prompt = state.get('next_move_choice')
        if state.get('phase') == 'Action Phase' and ordinary_prompt(match, prompt):
            key, stock = fingerprint(match, state['next_move_player'], prompt)
            self.exact[(None, key, stock, choices)] = 0

    def reach(self, path, position):
        parent, before = self.observations[path[:-1]]
        number = position.state.get('move_number', before)
        signature = (position.boundary, position.key, position.stock, position.choices)
        node = self.exact.get(signature) if position.key is not None else None
        new = node is None
        if new:
            node = len(self.edges)
            self.edges.append([])
            if position.key is not None:
                self.exact[signature] = node
        self.edges[parent].append((node, path[-1], number - before))
        self.observations[path] = (node, number)
        return node, new

    def routes(self, start=()):
        """Find shortest paths in explicit decisions, keeping actual prompt offsets."""
        node, number = self.observations[start]
        reached = {node: (start, number)}
        pending = deque([node])
        while pending:
            source = pending.popleft()
            path, number = reached[source]
            for target, move, increment in self.edges[source]:
                if target and target not in reached:
                    reached[target] = (path + (move,), number + increment)
                    pending.append(target)
        return reached

    def plan(self, path, endpoint=None):
        if not path:
            return path, endpoint
        route, number = self.routes()[self.observations[path][0]]
        # A cycle can reach the original position again. It supplies no plan.
        if not route:
            return (), None
        return route, None if endpoint is None else {**endpoint, 'move_number': number}


def fingerprint(match, owner, context):
    from nations_search_state import decision_key, freeze

    actor = next(player for player in match.players if player.name == owner)
    return decision_key(match, owner, context, None, exact=True), freeze(actor.resources)


def ordinary_prompt(match, prompt):
    """Exclude prompts with a pending card or event continuation on the engine stack."""
    if prompt not in (MAIN, COMPLETE):
        return False
    frame = _getframe(1)
    while frame is not None:
        if frame.f_code.co_name == 'get_move' and frame.f_locals.get('self') is match:
            caller = frame.f_back
            if prompt == MAIN and caller.f_code.co_name == 'take_one_action':
                caller = caller.f_back
            return caller.f_code.co_name == 'take_turn'
        frame = frame.f_back
    return False


def trace(replay, root_state, path, deadline, *, resolve_round=None, pre_move=False, capture_handoff=False):
    from nations import Match
    from nations.exceptions import GameOver
    owner = root_state['next_move_player']
    entered, offset, starting_actions = False, 0, 0
    projecting = False

    def check():
        if perf_counter() >= deadline:
            raise SearchBudget()

    def observation():
        position = match.get_state()
        if 'growth_allowances' in root_state:
            position['growth_allowances'] = {p.name: p.growth_resources for p in match.players}
            position['weighted_card_draw'] = match.weighted_card_draw
        return position

    def handoff(kind, actor):
        nonlocal projecting
        check()
        key, stock = fingerprint(match, owner, (kind, actor))
        if pre_move:
            position = observation() if capture_handoff else {}
            if capture_handoff:
                position['handoff_next_player'] = actor if kind == 'opponent turn' else None
                position['remaining_main_actions'] = {p.name: p.remaining_main_actions for p in match.players}
            raise InspectPosition(Position(position, boundary=kind, key=key, stock=stock))
        final_win = final_margin = None
        if resolve_round is not None:
            projecting = True
            try:
                match.resolution_phase()
            except GameOver:
                if kind == 'round resolution':
                    ordered = sorted(match.players, key=lambda p: (
                        -p.score(), -p.resource_remainder() if match.resource_remainder_tiebreaker else 0))
                    scores = {p.name: p.score() for p in ordered}
                    final_win = ordered[0].name == owner
                    final_margin = scores[owner] - scores[next(name for name in scores if name != owner)]
            finally:
                projecting = False
            check()
        position = match.get_state()
        position.update(next_move_player=actor, next_move_choice=MAIN, next_move_options=['Pass'])
        raise InspectPosition(Position(position, boundary=kind, key=key, stock=stock,
                                       final_win=final_win, final_margin=final_margin))

    class BranchMatch(Match):
        def production_phase(self):
            if entered and not projecting:
                handoff('round resolution', owner)
            return super().production_phase()

        def undo(self, invalid=False):
            if entered:
                raise SearchBoundary('engine rejected move')
            raise ValueError('Replay prefix no longer reproduces the current game')

    def guard(player, take_turn):
        def turn():
            if entered and player.name != owner:
                handoff('opponent turn', player.name)
            return take_turn()
        return turn

    def choose(prompt, options, _undo):
        nonlocal entered, offset, starting_actions
        check()
        actor = match.current_player
        guarded = safe_architect_options(match, prompt, options)
        if not entered:
            if (match.move_number != root_state['move_number'] or actor.name != owner
                    or prompt != root_state['next_move_choice']
                    or tuple(root_state['next_move_options']) not in (tuple(map(str, options)), tuple(map(str, guarded)))):
                raise ValueError('Current replay failed to reproduce the root prompt')
            lock_hidden_information(match)
            starting_actions = actor.action_number
            entered = True
        legal = {str(option): option for option in guarded if str(option) not in ADMIN}
        if not legal:
            raise SearchBoundary('no legal choice')
        if projecting:
            if prompt in (MAIN, COMPLETE):
                raise SearchBoundary('extra turn during resolution')
            if len(legal) == 1:
                return next(iter(legal.values()))
            selected = resolve_round(with_move_options(observation(), guarded), tuple(legal))
            if selected not in legal:
                raise ValueError('Round forecast selected an illegal choice')
            return legal[selected]
        if actor.name != owner:
            if len(legal) == 1 and not pre_move:
                return next(iter(legal.values()))
            raise SearchBoundary('opponent choice')
        allowed = tuple(legal)
        # Replay the root explicitly. Subsequent forced steps need no stored choice.
        if len(legal) == 1 and offset:
            selected = allowed[0]
        elif offset < len(path):
            selected = path[offset]
            if selected not in allowed:
                raise ValueError('Search line no longer legal')
            offset += 1
        else:
            position = with_move_options(observation(), guarded if pre_move else allowed)
            key, stock = fingerprint(match, owner, prompt) if ordinary_prompt(match, prompt) else (None, ())
            remaining = {p.name: p.remaining_main_actions for p in match.players} if capture_handoff else None
            raise InspectPosition(Position(position, allowed, actor.action_number - starting_actions,
                                           key=key, stock=stock, remaining_main_actions=remaining))
        return legal[selected]

    match = BranchMatch(replay=replay, move_getter=choose)
    for player in match.players:
        player.take_turn = guard(player, player.take_turn)
    try:
        match.play()
    except InspectPosition as stopped:
        if offset != len(path):
            raise ValueError('Search stopped before reaching its requested choice')
        return stopped.position
    except SearchBoundary as stopped:
        return Position({}, boundary=str(stopped))
    raise ValueError('Search left the action phase without a handoff')


def search(match, state, options, predict, direct, *, max_depth=3, max_nodes=40, seconds=.28, observe_leaf=None):
    """Rank ordinary prompts at width two and preserve complete small menus."""
    started = perf_counter()
    deadline = started + seconds
    owner = state['next_move_player']
    replay = match.get_replay()
    root_legal = tuple(str(option) for option in options if str(option) not in ADMIN)
    root_order = [row['move'] for row in direct['moves'] if row['move'] in root_legal][:2]
    pending = {move: [(move,)] for move in root_order}
    leaves = []
    positions = SearchPositions(match, state, root_legal)
    seen = {}
    counts = Counter()
    nodes = 0
    budget = False

    try:
        while len(root_order) == 2 and any(pending.values()):
            for root in root_order:
                if not pending[root]:
                    continue
                if nodes >= max_nodes or perf_counter() >= deadline:
                    raise SearchBudget()
                path = pending[root].pop()
                nodes += 1
                position = trace(replay, state, path, deadline)
                node, new = positions.reach(path, position)
                if not new:
                    counts['duplicate positions'] += 1
                    continue
                if position.boundary:
                    counts[position.boundary] += 1
                    if position.state:
                        value = predict(position.state)['winProbability']
                        if value is None:
                            continue
                        if position.state['next_move_player'] != owner:
                            value = 1 - value
                        if observe_leaf is not None:
                            observe_leaf(path, position.boundary, value)
                        leaves.append((node, position.boundary, value, path))
                    continue
                if position.state['next_move_choice'] == MAIN and position.main_actions >= max_depth:
                    counts['depth limit'] += 1
                    continue
                if position.key:
                    stocks = seen.setdefault((root, position.key, position.main_actions, position.choices), [])
                    if any(all(a >= b for a, b in zip(stock, position.stock)) for stock in stocks):
                        counts['merged or dominated'] += 1
                        continue
                    stocks.append(position.stock)
                choices = position.choices
                if position.state['next_move_choice'] == MAIN or len(choices) > 6:
                    ranked = predict(position.state)['moves']
                    choices = tuple(row['move'] for row in ranked if row['move'] in choices)[:2]
                pending[root].extend(path + (move,) for move in reversed(choices))
    except SearchBudget:
        budget = True

    line = ()
    if len(root_order) == 2 and not budget:
        frontiers = []
        for move in root_order:
            reachable = positions.routes((move,)) if (move,) in positions.observations else {}
            choices = {}
            for node, boundary, value, path in leaves:
                if node in reachable and (boundary not in choices or value > choices[boundary][0]):
                    choices[boundary] = value, path
            frontiers.append(choices)
        common = frontiers[0].keys() & frontiers[1].keys()
        # Compare one kind of frontier per decision. Rival and round-end values
        # use different actor contexts in the checkpoint.
        if len(common) == 1:
            frontier = next(iter(common))
            _, line = max((choices[frontier] for choices in frontiers), key=lambda row: row[0])
    line, _ = positions.plan(line)
    return {'line': line, 'nodes': nodes, 'budget': budget, 'boundaries': dict(counts),
            'duration_ms': (perf_counter() - started) * 1000}


def ranked_choices(prompt, legal, prediction, *, all_moves=False, width=2):
    aliases = prediction.get('move_aliases', {})
    if aliases:
        legal = tuple(move for move in legal if move not in aliases)
    ranked = tuple(row['move'] for row in prediction['moves'] if row['move'] in legal)
    if not all_moves and (prompt == MAIN or len(legal) > 6):
        return ranked[:width]
    return ranked + tuple(move for move in legal if move not in ranked)


def search_pre_move(match, state, options, predict, direct, *, max_nodes=64, seconds=.45):
    """Search to handoff using only predictions at real same-player prompts."""
    started = perf_counter()
    deadline = started + seconds
    replay = match.get_replay()
    allowed = tuple(str(option) for option in options if str(option) not in ADMIN)
    root_order = [row['move'] for row in direct['moves'] if row['move'] in allowed][:2]
    positions = SearchPositions(match, state, allowed)
    completed = {}
    counts = Counter()
    nodes = 0
    budget = False

    def visit(path, value, seen):
        nonlocal nodes
        if nodes >= max_nodes or perf_counter() >= deadline:
            raise SearchBudget()
        nodes += 1
        position = trace(replay, state, path, deadline, pre_move=True)
        node, new = positions.reach(path, position)
        if not new:
            counts['duplicate positions'] += 1
            return completed.get(node)
        if position.boundary:
            counts[position.boundary] += 1
            if position.boundary in HANDOFFS and value is not None:
                completed[node] = value, path
                return completed[node]
            return None
        if position.key:
            stocks = seen.setdefault((position.key, position.choices), [])
            if any(all(a >= b for a, b in zip(stock, position.stock)) for stock in stocks):
                counts['merged or dominated'] += 1
                return None
            stocks.append(position.stock)
        prediction = predict(position.state)
        if prediction['winProbability'] is not None:
            value = prediction['winProbability']
        choices = ranked_choices(position.state['next_move_choice'], position.choices, prediction)
        best = None
        for move in choices:
            leaf = visit(path + (move,), value, seen)
            if leaf is not None and (best is None or leaf[0] > best[0]):
                best = leaf
        completed[node] = best
        return best

    line = ()
    if len(root_order) == 2:
        try:
            results = [visit((move,), direct['winProbability'], {}) for move in root_order]
            if all(result is not None for result in results):
                _, line = max(results, key=lambda result: result[0])
        except SearchBudget:
            budget = True
    line, _ = positions.plan(line)
    return {'line': line, 'nodes': nodes, 'budget': budget, 'boundaries': dict(counts),
            'duration_ms': (perf_counter() - started) * 1000}


@dataclass
class PreMoveFrontier:
    path: tuple
    order: tuple
    value: float
    choices: tuple
    resume: dict | None = None


def handoff_observation(state, owner):
    """Use the same actor, prompt and menu when scoring resolved positions."""
    return {**state, 'next_move_player': owner, 'next_move_choice': MAIN, 'next_move_options': ['Pass']}


def search_policy_rollouts(match, state, options, predict, direct, *,
                           value_score, max_nodes=64, seconds=.45):
    """Finish greedily from each selected branch and compare only scored handoffs."""
    started = perf_counter()
    deadline = started + seconds
    replay = match.get_replay()
    allowed = tuple(str(option) for option in options if str(option) not in ADMIN)
    positions = SearchPositions(match, state, allowed)
    owner = state['next_move_player']
    queue, counts = [], Counter()
    queued = count()
    nodes = 0
    budget = False
    best = None
    baseline = None

    def follow(path, gap, *, move=None, prompt=None, legal=(), prediction=None):
        nonlocal nodes
        while True:
            if nodes >= max_nodes or perf_counter() >= deadline:
                raise SearchBudget()
            if move is None:
                choices = ranked_choices(prompt, legal, prediction, all_moves=True)
                if not choices:
                    return None
                move, *alternatives = choices
                preference = {row['move']: row.get('policy_gap', rank)
                              for rank, row in enumerate(prediction['moves'])}
                top = preference.get(move, 0)
                # A greedy continuation adds no loss. Compare alternatives
                # across menus by cumulative logit loss from their local best.
                for rank, alternative in enumerate(alternatives, start=1):
                    loss = max(0, preference.get(alternative, top + rank) - top)
                    heappush(queue, (gap + loss, len(path), next(queued), path, alternative))
            path += (move,)
            nodes += 1
            position = trace(replay, state, path, deadline, pre_move=True, capture_handoff=True)
            _, new = positions.reach(path, position)
            if not new:
                counts['duplicate positions'] += 1
                return None
            if position.boundary:
                counts[position.boundary] += 1
                if position.boundary not in RESOLVED_HANDOFFS:
                    return None
                counts_by_player = position.state['remaining_main_actions']
                if counts_by_player[owner] != 0:
                    counts['handoffs with actions left'] += 1
                    return None
                next_player = position.state['handoff_next_player']
                score = value_score(position.state, owner, next_player, counts_by_player,
                                    starts_turn=next_player is not None)
                counts['scored handoffs'] += 1
                return score, path, position.boundary
            prompt, legal = position.state['next_move_choice'], position.choices
            prediction = predict(position.state)
            move = None

    try:
        baseline = best = follow((), 0, prompt=state['next_move_choice'], legal=allowed, prediction=direct)
        if baseline is not None:
            counts['direct handoffs scored'] += 1
            while queue:
                gap, _, _, prefix, move = heappop(queue)
                candidate = follow(prefix, gap, move=move)
                if candidate is not None and candidate[0] > best[0]:
                    best = candidate
    except SearchBudget:
        budget = True

    score, path, boundary = best if best is not None else (None, (), None)
    line, _ = positions.plan(path)
    return {'line': line, 'nodes': nodes, 'budget': budget, 'boundaries': dict(counts),
            'line_value': score, 'line_boundary': boundary, 'selected_scored_handoff': bool(line),
            'direct_line_value': baseline[0] if baseline is not None else None,
            'duration_ms': (perf_counter() - started) * 1000}


def search_best_first(match, state, options, predict, direct, *,
                      max_nodes=64, seconds=.45, resume=None, width=2, strict_direct=False, score_gap=None,
                      handoff_score=False, value_score=None):
    """Expand the highest-valued reached position and retain a line on cutoff."""
    started = perf_counter()
    deadline = started + seconds
    replay = match.get_replay()
    allowed = tuple(str(option) for option in options if str(option) not in ADMIN)
    positions = SearchPositions(match, state, allowed)
    prompt = state['next_move_choice']
    if resume is not None:
        allowed = tuple(move for move in allowed if move in resume['choices'])
    def candidates(prompt, legal, prediction):
        choices = ranked_choices(prompt, legal, prediction, width=width)
        return choices[:1] if strict_direct else choices

    root_choices = candidates(prompt, allowed, direct)
    value = direct['winProbability']
    if value is None and resume is not None:
        value = resume['value']
    queue, seen = [], {}
    counts = Counter()
    nodes = 0
    budget = score_cutoff = False
    best_handoff = best_reached = best_unresolved = None
    trace_options = {'pre_move': True}
    if handoff_score:
        trace_options['capture_handoff'] = True

    def push(node):
        heappush(queue, (-node.value, node.order, node))

    def expand_edge(parent, rank, move):
        nonlocal nodes, best_handoff, best_reached, best_unresolved
        if nodes >= max_nodes or perf_counter() >= deadline:
            raise SearchBudget()
        path = parent.path + (move,)
        order = parent.order + (rank,)
        nodes += 1
        position = trace(replay, state, path, deadline, **trace_options)
        if not parent.path:
            counts['root branches inspected'] += 1
        _, new = positions.reach(path, position)
        if not new:
            counts['duplicate positions'] += 1
            return
        if position.boundary:
            counts[position.boundary] += 1
            if position.boundary in HANDOFFS:
                score = parent.value
                if handoff_score:
                    if position.boundary not in RESOLVED_HANDOFFS:
                        candidate = (-score, order, path, position.boundary)
                        if best_unresolved is None or candidate < best_unresolved:
                            best_unresolved = candidate
                        return
                    owner = state['next_move_player']
                    if value_score is None:
                        score = predict(handoff_observation(position.state, owner))['winProbability']
                    else:
                        next_player = position.state['handoff_next_player']
                        score = value_score(position.state, owner, next_player,
                                            position.state['remaining_main_actions'],
                                            starts_turn=next_player is not None)
                    counts['scored handoffs'] += 1
                candidate = (-score, order, path, position.boundary)
                if best_handoff is None or candidate < best_handoff:
                    best_handoff = candidate
            return
        if position.key:
            stocks = seen.setdefault((path[0], position.key, position.choices), [])
            if any(all(a >= b for a, b in zip(stock, position.stock)) for stock in stocks):
                counts['merged or dominated'] += 1
                return
            stocks.append(position.stock)
        prediction = predict(position.state)
        prompt = position.state['next_move_choice']
        if value_score is None:
            score = prediction['winProbability']
        elif prompt == MAIN:
            owner = state['next_move_player']
            score = value_score(position.state, owner, owner, position.remaining_main_actions)
        else:
            score = None
        choices = candidates(prompt, position.choices, prediction)
        if choices:
            # An inherited score can order work, but only a fresh score can
            # justify playing this prefix and resuming from its endpoint.
            endpoint = None
            if score is not None:
                endpoint = {'move_number': position.state['move_number'], 'prompt': prompt,
                            'choices': position.choices, 'value': score}
                if score_gap is not None:
                    reached = (-score, order, path, endpoint)
                    if best_reached is None or reached[:2] < best_reached[:2]:
                        best_reached = reached
            push(PreMoveFrontier(path, order, parent.value if score is None else score, choices, endpoint))

    if value is not None and root_choices and (len(root_choices) >= 2 or width == 1 or resume is not None):
        push(PreMoveFrontier((), (), value, root_choices))
    while queue:
        if score_gap is not None:
            known = [line[0] for line in (best_handoff, best_reached) if line is not None]
            if known and queue[0][0] - min(known) > score_gap:
                score_cutoff = True
                break
        _, _, parent = heappop(queue)
        try:
            for rank, move in enumerate(parent.choices):
                expand_edge(parent, rank, move)
        except SearchBudget:
            budget = True
            if parent.path:
                push(parent)
            break

    completed = best_handoff or best_unresolved
    line = completed[2] if completed else ()
    line_score = -completed[0] if completed else None
    line_boundary = completed[3] if completed else None
    endpoint = None
    if score_cutoff and best_reached is not None and (best_handoff is None or best_reached[0] < best_handoff[0]):
        line, endpoint = best_reached[2:]
        line_score, line_boundary = endpoint['value'], None
    elif budget and (not handoff_score or best_handoff is None):
        scored = min((item for item in queue if item[2].resume is not None), default=None)
        if scored is not None and (completed is None or scored[0] < completed[0]):
            best = scored[2]
            line, endpoint = best.path, best.resume
            line_score, line_boundary = best.value, None
    line, endpoint = positions.plan(line, endpoint)
    result = {'line': line, 'resume': endpoint, 'nodes': nodes, 'budget': budget,
              'line_value': line_score if line else None, 'line_boundary': line_boundary if line else None,
              'boundaries': dict(counts), 'duration_ms': (perf_counter() - started) * 1000}
    if score_gap is not None:
        result['score_cutoff'] = score_cutoff
    if handoff_score:
        result['selected_scored_handoff'] = bool(line and line_boundary in RESOLVED_HANDOFFS)
    return result


def search_broad_best_first(match, state, options, predict, direct, *,
                            score_gap, max_nodes=64, seconds=.45, resume=None):
    """Queue all eligible moves using their parent estimates as priorities."""
    started = perf_counter()
    deadline = started + seconds
    replay = match.get_replay()
    allowed = tuple(str(option) for option in options if str(option) not in ADMIN)
    positions = SearchPositions(match, state, allowed)
    prompt = state['next_move_choice']
    if resume is not None:
        allowed = tuple(move for move in allowed if move in resume['choices'])
    root_choices = ranked_choices(prompt, allowed, direct, all_moves=True)
    value = direct['winProbability']
    if value is None and resume is not None:
        value = resume['value']
    queue, seen = [], {}
    counts = Counter()
    nodes = 0
    budget = score_cutoff = False
    best_handoff = best_reached = None

    def enqueue(parent):
        for rank, move in enumerate(parent.choices):
            order = parent.order + (rank,)
            heappush(queue, (-parent.value, len(order), order, move, parent))

    if value is not None and (len(root_choices) >= 2 or resume is not None and root_choices):
        enqueue(PreMoveFrontier((), (), value, root_choices))
    try:
        while queue:
            priority, _, order, move, parent = queue[0]
            # This compares estimates for reached prompts. A queued move's
            # priority is a heuristic, not a bound on the position it reaches.
            known = [line[0] for line in (best_handoff, best_reached) if line is not None]
            if known and priority - min(known) > score_gap:
                score_cutoff = True
                break
            if nodes >= max_nodes or perf_counter() >= deadline:
                raise SearchBudget()
            heappop(queue)
            path = parent.path + (move,)
            nodes += 1
            position = trace(replay, state, path, deadline, pre_move=True)
            if not parent.path:
                counts['root branches inspected'] += 1
            _, new = positions.reach(path, position)
            if not new:
                counts['duplicate positions'] += 1
                continue
            if position.boundary:
                counts[position.boundary] += 1
                candidate = (priority, order, path)
                if position.boundary in HANDOFFS and (best_handoff is None or candidate < best_handoff):
                    best_handoff = candidate
                continue
            if position.key:
                stocks = seen.setdefault((path[0], position.key, position.choices), [])
                if any(all(a >= b for a, b in zip(stock, position.stock)) for stock in stocks):
                    counts['merged or dominated'] += 1
                    continue
                stocks.append(position.stock)
            prediction = predict(position.state)
            score = prediction['winProbability']
            prompt = position.state['next_move_choice']
            choices = ranked_choices(prompt, position.choices, prediction, all_moves=True)
            if choices:
                enqueue(PreMoveFrontier(path, order, parent.value if score is None else score, choices))
                if score is not None:
                    endpoint = {'move_number': position.state['move_number'], 'prompt': prompt,
                                'choices': position.choices, 'value': score}
                    reached = (-score, order, path, endpoint)
                    if best_reached is None or reached[:2] < best_reached[:2]:
                        best_reached = reached
    except SearchBudget:
        budget = True

    line = best_handoff[2] if best_handoff else ()
    endpoint = None
    if (budget or score_cutoff) and best_reached is not None and (
            best_handoff is None or best_reached[0] < best_handoff[0]):
        line, endpoint = best_reached[2:]
    line, endpoint = positions.plan(line, endpoint)
    return {'line': line, 'resume': endpoint, 'nodes': nodes, 'budget': budget, 'score_cutoff': score_cutoff,
            'boundaries': dict(counts), 'duration_ms': (perf_counter() - started) * 1000}
