"""Evaluate one complete engine action from a public action prompt."""
from copy import copy, deepcopy
from dataclasses import dataclass

from nations.actions import ActionType
from nations.exceptions import InvalidMove
from nations_lookahead import HiddenInformation, SearchBoundary, lock_hidden_information
from nations_move_safety import safe_architect_options


HIDDEN = {'event_cards', 'initial_event_card_order', 'progress_cards', 'initial_progress_card_order',
          'separated_decks', 'random', 'seed', 'nations', 'initial_nation_order'}
HISTORY = {'move_getter', 'logger', 'log_lines', 'replay_lines', 'move_list'}
EXCLUDED = {'UNDO', 'Resign'}


@dataclass
class AfterMove:
    state: dict
    choices: tuple
    actions_left: int


def fork_action(match, action):
    branch = copy(match)
    memo = {id(match): branch}
    for name, value in vars(match).items():
        if name not in HIDDEN and name not in HISTORY:
            setattr(branch, name, deepcopy(value, memo))
    lock_hidden_information(branch)
    branch.nations = branch.initial_nation_order = HiddenInformation('unused nations')
    branch.logger = None
    branch.log_lines, branch.replay_lines, branch.move_list = [[]], [], []
    return branch, deepcopy(action, memo)


def evaluate_action(match, action, select_followup):
    """Return the public board after this action, or stop at a hidden outcome."""
    if str(action) in EXCLUDED or match.next_move_choice != 'Which action?' or match.phase.name != 'ACTION':
        raise ValueError('Expected a playable main action')
    if not safe_architect_options(match, match.next_move_choice, (action,)):
        return 'no legal main action'
    branch, move = fork_action(match, action)
    actor = branch.current_player
    followups = []

    def choose(prompt, options, _undo):
        options = safe_architect_options(branch, prompt, options)
        legal = {str(option): option for option in options if str(option) not in EXCLUDED}
        if not legal:
            raise SearchBoundary('no legal follow-up')
        selected = select_followup(branch, tuple(legal))
        if selected not in legal:
            raise ValueError('Follow-up selector returned an unavailable choice')
        if len(options) > 1:
            followups.append((branch.next_move_player, selected))
        return legal[selected]

    branch.move_getter = choose
    branch.undo_allowed = True
    branch.undo_disallowed_reason = None
    branch.invalid_move = None
    branch.move_number += 1
    actor.need_confirmation = True
    try:
        actor.take_action(move)
        if move.action_type is ActionType.PASS:
            actor.remaining_main_actions = 0
        elif move.action_type is not ActionType.UNDEPLOY:
            actor.remaining_main_actions -= 1
            actor.action_number += 1
        position = branch.get_state()
    except (SearchBoundary, InvalidMove) as error:
        return str(error)
    position['next_move_player'] = actor.name
    position.pop('next_move_choice')
    position.pop('next_move_options')
    return AfterMove(position, tuple(followups), actor.remaining_main_actions)
