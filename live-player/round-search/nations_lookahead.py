"""Bounded two-player search using Tabony's engine, with no hidden draws in branches."""
from dataclasses import dataclass
from time import perf_counter



class SearchBoundary(Exception):
    pass


class PublicDecision(Exception):
    pass


class SearchBudget(Exception):
    pass


class HiddenInformation:
    def __init__(self, reason):
        self.reason = reason

    def blocked(self, *_args):
        raise SearchBoundary(self.reason)

    __getitem__ = __setitem__ = __delitem__ = __getattr__ = __iter__ = __len__ = __bool__ = blocked


def lock_hidden_information(match):
    for name, label in {
        'event_cards': 'unrevealed event', 'initial_event_card_order': 'unrevealed event',
        'progress_cards': 'unrevealed progress cards', 'initial_progress_card_order': 'unrevealed progress cards',
        'separated_decks': 'unrevealed progress cards', 'random': 'random outcome', 'seed': 'hidden seed',
    }.items():
        setattr(match, name, HiddenInformation(label))


def legal_choices(state):
    return [option for option in state['next_move_options'] if option not in ('UNDO', 'Resign')]


@dataclass(frozen=True)
class Result:
    value: float | None
    line: tuple
    stop: str
    frontier: tuple | None = None

    @property
    def comparison_key(self):
        return (len(self.line), self.frontier) if self.value is not None and self.frontier is not None else None


@dataclass(frozen=True)
class Transition:
    position: dict | None = None
    winner: str | None = None
    stop: str | None = None
    frontier: tuple | None = None


def branch(root, root_state, path, deadline):
    """Replay the observed prefix unmodified and guard everything after it."""
    from nations import Match

    progress = 0
    choices_taken = 0
    entered = False

    def choose(prompt, options, _undo):
        nonlocal progress, choices_taken, entered
        if perf_counter() >= deadline:
            raise SearchBudget()
        if match.invalid_move:
            raise SearchBoundary('engine rejected a branch move')
        if not entered:
            if (match.move_number != root_state['move_number'] or prompt != root_state['next_move_choice']
                    or match.next_move_player != root_state['next_move_player']
                    or tuple(root_state['next_move_options']) != tuple(map(str, options))):
                raise ValueError('The replay prefix did not reproduce the current decision.')
            lock_hidden_information(match)
            entered = True
        by_name = {str(option): option for option in options if str(option) not in ('UNDO', 'Resign')}
        if progress < len(path) and (progress == 0 or len(by_name) != 1):
            selected = path[progress]
            progress += 1
            if selected not in by_name:
                raise ValueError('A branch move was not offered by the engine.')
        elif len(by_name) == 1:
            selected = next(iter(by_name))
        elif not by_name:
            raise SearchBoundary('no playable choice')
        else:
            raise PublicDecision()
        if not selected.startswith('Confirm'):
            choices_taken += 1
        return by_name[selected]

    class BranchMatch(Match):
        def undo(self, invalid=False):
            if entered:
                raise SearchBoundary('engine rejected a branch move' if invalid else 'undo')
            return super().undo(invalid=invalid)

    match = BranchMatch(replay=root, move_getter=choose)
    try:
        match.play()
    except PublicDecision:
        if perf_counter() >= deadline:
            raise SearchBudget()
        # These counters describe the decision horizon, not the board's value.
        # Undeploy leaves the main action available, so counting choices alone
        # can compare its intermediate state with the end of another turn.
        frontier = (match.round_number, match.phase, match.next_move_player, match.next_move_choice, choices_taken,
                    tuple((p.name, p.passed, getattr(p, 'turn_number', None), getattr(p, 'action_number', None),
                           getattr(p, 'remaining_main_actions', None))
                          for p in sorted(match.players, key=lambda player: player.name)))
        return Transition(position=match.get_state(), frontier=frontier)
    except SearchBoundary as boundary:
        return Transition(stop=str(boundary))
    if not entered or progress != len(path) or not match.game_over or match.phase.name != 'SCORING':
        return Transition(stop='engine stopped before final scoring')
    winner = min(match.players, key=lambda player: (
        -player.score(), -player.resource_remainder() if match.resource_remainder_tiebreaker else 0))
    return Transition(winner=winner.name, stop='final scoring', frontier=('final scoring',))


def explore(match, evaluate, *, depth=3, candidates=4, width=2, max_nodes=60, seconds=1.25, recommendation_only=False):
    """Evaluate model-shortlisted choices without sampling hidden outcomes.

    Back up values only from comparable endpoints. A recommendation must beat
    the direct policy on a shared horizon; other lines remain inspectable.
    """
    state = match.get_state()
    owner = state['next_move_player']
    if len(state['players']) != 2 or state['game_over'] or not owner:
        return {'unavailable': 'Predictive analysis needs an active two-player decision.'}
    legal = legal_choices(state)
    if len(legal) < 2:
        return {'unavailable': 'There is no strategic choice at this decision.'}

    started = perf_counter()
    deadline = started + seconds
    root = match.get_replay()
    transitions, predictions, evaluations = {}, {}, {}
    nodes = 0

    def check():
        if perf_counter() >= deadline:
            raise SearchBudget()

    def assessed(position, path):
        check()
        if path in predictions:
            return predictions[path]
        prediction = evaluate(position)
        check()
        probability = prediction['winProbability']
        if probability is not None and position['next_move_player'] != owner:
            probability = 1 - probability
        available = legal_choices(position)
        ranked = [entry['move'] for entry in prediction['moves'] if entry['move'] in available]
        predictions[path] = probability, list(dict.fromkeys([*ranked, *available]))
        return predictions[path]

    def follow(path, line, remaining):
        key = (path, remaining)
        if key not in evaluations:
            evaluations[key] = evaluate_branch(path, line, remaining)
        return evaluations[key]

    def evaluate_branch(path, line, remaining):
        nonlocal nodes
        check()
        if path not in transitions:
            if nodes >= max_nodes:
                raise SearchBudget()
            nodes += 1
            transitions[path] = branch(root, state, path, deadline)
        transition = transitions[path]
        if transition.stop:
            value = float(transition.winner == owner) if transition.winner is not None else None
            return Result(value, line, transition.stop, transition.frontier)
        position = transition.position
        value, moves = assessed(position, path)
        if remaining == 0:
            stop = 'search depth' if value is not None else 'value model does not cover this prompt'
            return Result(value, line, stop, transition.frontier)
        actor = position['next_move_player']
        children = [follow(path + (move,), line + ((actor, move),), remaining - 1) for move in moves[:width]]
        missing = next((child for child in children if child.comparison_key is None), None)
        if missing or len({child.comparison_key for child in children}) > 1:
            # An unknown or mismatched reply cannot be treated as a worse one.
            earlier = follow(path, line, remaining - 1)
            return Result(earlier.value, earlier.line, missing.stop if missing else 'different reply endpoints', earlier.frontier)
        if not children:
            return Result(value, line, 'no continuation', transition.frontier)
        return (max if actor == owner else min)(children, key=lambda child: child.value)

    root_probability = None
    explored = {}
    comparable = {}
    completed = 0
    root_moves = []
    limited = False
    try:
        root_probability, root_moves = assessed(state, ())
        for level in range(1, depth + 1):
            results = {}
            for move in root_moves[:candidates]:
                outcome = follow((move,), ((owner, move),), level - 1)
                results[move] = outcome
                if recommendation_only and len(results) == 1 and transitions[(move,)].position is None and outcome.value is None:
                    break  # No search depth can recover the preferred move's unknown successor.
            explored = results
            completed = level
            direct = results[root_moves[0]]
            group = {move: outcome for move, outcome in results.items()
                     if direct.comparison_key is not None and outcome.comparison_key == direct.comparison_key}
            if len(group) >= 2 and (not comparable or len(direct.line) >= len(comparable[root_moves[0]].line)):
                comparable = group
            if recommendation_only and len(results) == 1 and direct.value is None:
                break
    except SearchBudget:
        limited = True

    policy_move = root_moves[0] if root_moves else None
    compared = sorted(comparable, key=lambda move: -comparable[move].value)
    recommended = compared[0] if compared else policy_move
    order = list(dict.fromkeys([*compared, *explored]))
    rows = []
    for move in order:
        outcome = (comparable if move in comparable else explored)[move]
        rows.append({'move': move, 'winProbability': outcome.value, 'comparable': move in comparable,
                     'line': [{'player': name, 'move': action} for name, action in outcome.line], 'stop': outcome.stop})
    return {'player': owner, 'rootWinProbability': root_probability, 'policyMove': policy_move,
            'recommendedMove': recommended, 'moves': rows, 'nodes': nodes,
            'completedDepth': completed, 'depth': depth, 'legalChoices': len(legal), 'replyWidth': width,
            'budgetReached': limited, 'durationMs': round((perf_counter() - started) * 1000, 1)}
