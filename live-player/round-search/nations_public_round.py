"""Rebuild ordinary action prompts from the public board and decision history."""
import ast
from dataclasses import dataclass, field
from functools import lru_cache
from inspect import getsource
from textwrap import dedent
from time import perf_counter

from nations import Match
from nations.actions import ConfirmAction
from nations.exceptions import GameOver, InvalidMove
from nations.phases import Phase
from nations.resources import Resource, Resources
from nations_lookahead import SearchBoundary, SearchBudget, lock_hidden_information
from nations_microsearch import ADMIN, MAIN, COMPLETE, ranked_choices
from nations_move_safety import safe_architect_options, with_move_options


class PublicPositionUnavailable(SearchBoundary):
    pass


@dataclass
class PublicTurns:
    round: int = 0
    number: int = -1
    log: str = ''
    phase: str = ''
    prompt: str = ''
    actor: str = ''
    remaining: dict = field(default_factory=dict)
    spent: dict = field(default_factory=dict)
    started: dict = field(default_factory=dict)
    paid: set = field(default_factory=set)
    tower_ready: bool = False
    tower_owner: str | None = None
    trusted: bool = False

    def observe(self, state, log):
        number, round_number = state['move_number'], state['round']
        if number == self.number and log == self.log:
            return
        if round_number != self.round:
            # A complete log can bootstrap at the start of a round. A jump
            # into an action sequence needs the missing public observations.
            starts = state['round_starts']
            self.trusted = state['phase'] != 'Action Phase' or number == starts.get(round_number, starts.get(str(round_number)))
            self.remaining.clear()
            self.spent.clear()
            self.started.clear()
            self.paid.clear()
            self.tower_ready = False
            self.round = round_number
        elif number != self.number + 1 or not log.startswith(self.log):
            self.trusted = False
        if self.actor and self.phase == 'Action Phase' and self.prompt == MAIN and number == self.number + 1:
            lines = log[len(self.log):].splitlines()
            if not (lines and lines[0].startswith(self.actor + ' undeploys 1 [Worker] from ')):
                self.consume(self.actor)
        lines = log[len(self.log):].splitlines()
        for line in lines:
            for player in state['players']:
                if line == f'[Sun Tzu] {player} takes 2 actions.':
                    self.remaining[player] = 2
                elif line == f'[Buddha] {player} skips first turn.':
                    self.started[player] = 1
                elif line == f'[Jagellonian Dynasty] {player} pays.':
                    self.paid.add(player)
                elif line == f'{player} passes.':
                    self.remaining[player] = 0
                elif line.startswith(player + ' explores "'):
                    self.consume(player)
                    if player not in self.paid:
                        self.started[player] = max(1, self.started.get(player, 0))
            if line == '"Wardenclyffe Tower" is ready.':
                self.tower_ready = True
        tower = next((name for name, player in state['players'].items()
                      if any(slot.startswith('W') and cid == 'WcTw' for slot, cid in player.get('slots', {}).items())), None)
        if tower and tower != self.tower_owner and self.tower_ready:
            self.remaining[tower] = self.remaining.get(tower, 0) + 3
            self.tower_ready = False
        self.tower_owner = tower
        if self.phase == 'Action Phase' and self.prompt == COMPLETE and self.actor in self.paid:
            if not any(line.startswith(self.actor + ' undeploys 1 [Worker] from ') for line in lines):
                self.paid.remove(self.actor)
        self.actor, self.prompt, self.phase = state['next_move_player'], state['next_move_choice'], state['phase']
        if self.phase == 'Action Phase' and self.prompt == MAIN:
            self.remaining[self.actor] = max(1, self.remaining.get(self.actor, 0))
            if self.actor not in self.paid:
                self.started[self.actor] = max(1, self.started.get(self.actor, 0))
        if self.phase == 'Action Phase' and self.prompt == COMPLETE:
            self.remaining[self.actor] = 0
        self.number, self.log = number, log

    def consume(self, actor):
        self.spent[actor] = self.spent.get(actor, 0) + 1
        self.remaining[actor] = max(0, self.remaining.get(actor, 1) - 1)


@lru_cache(maxsize=None)
def registrations(method):
    """Read the engine's declarative hook registrations without repeating card rewards."""
    body = ast.parse(dedent(getsource(method))).body[0].body
    result = []
    for statement in body:
        if not isinstance(statement, ast.Expr) or not isinstance(statement.value, ast.Call):
            if any(isinstance(node, ast.Attribute) and node.attr == 'register_for_event'
                   for node in ast.walk(statement)):
                raise PublicPositionUnavailable('conditional card registration')
            continue
        call = statement.value
        if isinstance(call.func, ast.Attribute) and call.func.attr == 'register_for_event':
            hook, condition, handler = call.args
            result.append((ast.literal_eval(hook), condition.attr, handler.attr))
    return tuple(result)


def restore_hooks(card, *methods):
    for name in methods:
        method = getattr(type(card), name, None)
        if method is not None:
            for hook, condition, handler in registrations(method):
                card.register_for_event(hook, getattr(card, condition), getattr(card, handler))


# These cards retain counters or references outside the public card state.
UNTRACKED = {'Sheba', 'AchaemenidEmpire', 'RigvedaExodus',
             'StuporMundiGreatSchism', 'MagellansExpeditionPapalIndulgence'}
GLOBAL_HOOKS = {'BrandenburgGate', 'Hannibal', 'GenghisKhan', 'MartinLuther',
                'Pocahontas', 'ShakaZulu', 'OresundDues', 'Versailles'}
PLAYER_FIELDS = {'workers': 'workers', 'grown_workers': 'grown_workers', 'points': 'points',
                 'extra_worker_pool': 'extra_workers', 'turmoil': 'turmoil',
                 'passed': 'passed', 'passed_first': 'passed_first', 'passed_last': 'passed_last',
                 'most_stability': 'most_stability', 'least_stability': 'least_stability',
                 'most_military': 'most_military', 'least_military': 'least_military',
                 'bought_colony_this_round': 'bought_colony'}
CARD_FIELDS = {'private_architects_available': 'private', 'markers': 'markers', 'global_effect': 'global',
               'deployed_workers': 'deployed', 'completed_stages': 'architects', 'turns_explored': 'explored'}


def resources(values):
    return Resources({kind: values.get(str(kind), 0) for kind in Resource})


def restore_round(state, turns, rules, choose):
    if not turns.trusted or state['phase'] != 'Action Phase' or state['next_move_choice'] != MAIN:
        raise PublicPositionUnavailable('unverified action context')
    roster = state['player_order']
    if len(roster) != 2 or not state['event']:
        raise PublicPositionUnavailable('expected two players and a revealed event')
    if not {'growth_allowances', 'weighted_card_draw', 'resource_tiebreak'} <= state.keys():
        raise PublicPositionUnavailable('missing public rules')
    # This seed initializes the engine catalogue only. Every playable card
    # comes from the snapshot and all deck access is disabled before play.
    config = {**rules, 'extra_draft_nations': -1, 'growth_resources': -1,
              'player_growth_resources': state['growth_allowances']}
    match = Match(player_names=roster, seed='00', move_getter=choose, rules=config)
    people = {p.name: p for p in match.players}
    match.players = [people[name] for name in roster]
    match.first_round_player_order = [people[name] for name in state['first_round_player_order']]
    stock = {card.abbr: card for deck in match.initial_progress_card_order.values() for card in deck}
    stock.update({card.abbr: card for nation in match.nations for card in nation.all_slots() if card is not None})
    from nations.progress_cards import all_extension_cards
    for kind in all_extension_cards:
        card = kind(match)
        card.reset()
        stock[card.abbr] = card
    match.event = next((card for deck in match.initial_event_card_order.values() for card in deck
                        if card.abbr == state['event']), None)
    if match.event is None or type(match.event).__name__ in UNTRACKED:
        raise PublicPositionUnavailable('untracked event state')
    match.phase = Phase.ACTION
    match.round_number = state['round']
    match.round_starts = dict(state['round_starts'])
    match.move_number = state['move_number']
    match.architects, match.turmoil = state['architects'], state['turmoil']
    match.war = stock[state['war']] if state['war'] else None
    match.war_value = state['war_value']
    match.available_nations = []
    match.cards_bought = 0  # Used by statistics only.
    match.event.reveal()
    rows = max([3, *(int(slot[1]) for slot in state['progress_board'])])
    match.progress_board = [[stock.get(state['progress_board'].get(f'P{row}{col}'))
                             for col in range(1, 1 + max([4, *(int(slot[2:]) for slot in state['progress_board']
                                                               if int(slot[1]) == row)]))]
                            for row in range(1, 1 + rows)]
    round_log = turns.log.rsplit('Beginning of Round ', 1)[-1].splitlines()
    active = []
    nations = {nation.name: nation for nation in match.nations}
    for player in match.players:
        player.assign_nation(nations[state['players'][player.name]['nation']])
    for player in match.players:
        public = state['players'][player.name]
        for starting in player.all_cards():
            if starting.abbr not in public['cards']:
                starting.unregister_all_events()
        for slot, _ in player.slot_names_cards():
            kind, index = player.slot_type_index_from_slot(slot)
            slots = player.slots_from_slot_type(kind)
            slots[index] = stock[public['slots'][slot]] if slot in public['slots'] else None
        for slot, cid in public['slots'].items():
            if slot == 'Hire':
                player.wonders_under_construction[0] = stock[cid]
            elif not any(actual == slot for actual, _ in player.slot_names_cards()):
                kind, index = player.slot_type_index_from_slot(slot)
                slots = player.slots_from_slot_type(kind)
                slots.extend([None] * (index + 1 - len(slots)))
                slots[index] = stock[cid]
        player.dynasties = [stock[cid] if cid else None for cid in public['dynasties']]
        for cid, visible in public['cards'].items():
            card = stock[cid]
            card.owner = player
            for attr, key in CARD_FIELDS.items():
                if hasattr(card, attr) or key in visible:
                    setattr(card, attr, visible.get(key, 0))
            card.covered_by = stock[visible['covered_by']] if 'covered_by' in visible else None
            if 'marked' in visible:
                card.marked_cards = [stock[marked] for marked in visible['marked'] if marked in stock]
            if hasattr(card, 'resources') or 'resources' in visible:
                card.resources = resources(visible.get('resources', {}))
        linked = {card.abbr for card in player.all_cards()}
        player.extra_cards = [stock[cid] for cid in public['cards'] if cid not in linked]
        for attr, key in PLAYER_FIELDS.items():
            setattr(player, attr, public[key])
        player.resources = resources(public['resources'])
        player.resource_deficit_points = resources(public['resource_deficit_points'])
        for pool in player.worker_pools:
            visible = public['worker_pools'][str(pool.resource_cost_per_worker)]
            pool.ungrown_workers = visible['workers']
            pool.markers = visible.get('markers', 0)
            pool.total_resource_cost = (pool.spots - pool.ungrown_workers - pool.markers) * pool.resource_cost_per_worker
        player.turn_number = turns.started.get(player.name, 0)
        player.action_number = turns.spent.get(player.name, 0) + 1
        player.remaining_main_actions = turns.remaining.get(player.name, 0) if player.name == turns.actor else 0
        player.need_confirmation = False
        eligible = set(player.completed_cards()) | set(player.extra_cards)
        for card in player.all_cards():
            if card in player.dynasty_cards():
                continue
            if type(card).__name__ in UNTRACKED:
                raise PublicPositionUnavailable('untracked card state')
            methods = ('play',) if card.is_dynasty() else ('buy',)
            if card in eligible:
                methods += ('ready', 'discovered', 'placed')
            if card.abbr == 'PlHc' and f'"{card}" has been discovered.' not in round_log:
                methods = tuple(method for method in methods if method != 'discovered')
            if card.is_golden_age() and card in player.extra_cards:
                methods += ('activate',)
            active.append((card, methods))
        if f'[Le Vite] {player.name} chooses the special ability.' in round_log:
            card = next(card for card in stock.values() if card.abbr == 'LeVt')
            card.owner = player
            active.append((card, ('activate',)))
    for card, methods in sorted(active, key=lambda entry: turns.log.rfind('"' + str(entry[0]) + '"')):
        name = type(card).__name__
        if name in GLOBAL_HOOKS and not card.global_effect:
            continue
        if name in ('BrandenburgGate', 'Montezuma'):
            card.prev_card = None
        if name == 'Sparta':
            card.active = sum(c.deployed_workers for c in card.owner.military_cards()) == 1
        if name == 'JagellonianDynasty':
            card.paid = card.owner.name in turns.paid
        if name == 'AxumiteKingdom':
            # reset() initializes the empty list even when no marker is held.
            card.marked_cards = getattr(card, 'marked_cards', [])
        restore_hooks(card, *methods)
    match.current_player = people[turns.actor]
    match.previous_player = match.current_player
    lock_hidden_information(match)
    return match


def finish_turn(match, player, opener=False):
    while player.remaining_main_actions:
        player.take_one_action()
    while opener or player.need_confirmation:
        options = [ConfirmAction()]
        if not player.passed and not player.explore_actions():
            options += player.undeploy_actions()
        action = match.get_move(player, COMPLETE, options)
        if str(action) == 'Confirm':
            return
        player.take_action(action)


def forward(match, current, opener):
    finish_turn(match, current, opener)
    if opener:
        current = match.players[0]
        if any(not player.passed for player in match.players):
            current.take_turn()
    while True:
        successor = current
        passed = []
        while True:
            successor = match.next_player_forward(successor)
            if not successor.passed or successor is current:
                break
            passed.append(successor)
        if successor.passed:
            break
        for player in passed:
            match.events.happen('passed over', player)
        current = successor
        current.take_turn()
    match.resolution_phase()


def public_rollout(state, turns, rules, prefix, predict, branch, deadline, *, observe, on_prompt=None):
    moves = []
    owner = state['next_move_player']

    def choose(prompt, options, _undo):
        if perf_counter() >= deadline:
            raise SearchBudget()
        guarded = safe_architect_options(match, prompt, options)
        legal = {str(option): option for option in guarded if str(option) not in ADMIN}
        if not moves and (prompt != MAIN or match.next_move_player != owner
                          or set(legal) != set(state['next_move_options']) - ADMIN):
            raise PublicPositionUnavailable('root legal moves differ')
        if on_prompt is not None:
            on_prompt(match.next_move_player, prompt, set(legal))
        if len(moves) < len(prefix):
            move = prefix[len(moves)]
        elif len(legal) == 1:
            move = next(iter(legal))
        elif legal:
            prediction = predict(with_move_options(observe(match), guarded))
            order = ranked_choices(prompt, legal, prediction, all_moves=True)
            move = order[0]
            if match.next_move_player == owner:
                branch(tuple(moves), order, prediction)
        else:
            raise PublicPositionUnavailable('no legal simulated choice')
        if move not in legal:
            raise PublicPositionUnavailable('simulated path no longer legal')
        moves.append(move)
        return legal[move]

    try:
        match = restore_round(state, turns, rules, choose)
        for name, public in state['players'].items():
            rebuilt = next(player for player in match.players if player.name == name).state()
            if rebuilt != public:
                changed = ', '.join(key for key in public if rebuilt.get(key) != public[key])
                raise PublicPositionUnavailable(f'root player state differs: {changed}')
        if match.current_player.explore_actions():
            raise PublicPositionUnavailable('root has forced exploration')
        forward(match, match.current_player, owner in turns.paid)
    except (InvalidMove, AttributeError, IndexError, KeyError, StopIteration) as error:
        raise PublicPositionUnavailable(f'incomplete engine state: {type(error).__name__}') from error
    except GameOver:
        if not match.game_over or match.round_number != 8:
            raise PublicPositionUnavailable('unexpected game end')
    if len(moves) < len(prefix):
        raise PublicPositionUnavailable('settlement arrived before line ended')
    settled = observe(match)
    if match.game_over:
        ordered = sorted(match.players, key=lambda p: (-p.score(), -p.resource_remainder()
                                                      if match.resource_remainder_tiebreaker else 0))
        points = {p.name: p.score() for p in ordered}
        settled['final_winner'] = ordered[0].name
        settled['final_margin'] = points[owner] - points[next(name for name in points if name != owner)]
    return settled | {'rollout_moves': tuple(moves), 'sampled_draw': False}
