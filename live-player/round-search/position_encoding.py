"""Current-board features for the offline encoding comparison."""
from functools import lru_cache
import re

import numpy as np

from encoding import Encoder, RESOURCES, TYPES, amount, policy_prompt


SCHEMA = 'current-position-v1'
PROMPTS = ('Draft which nation?', 'Take what for growth?', 'Which action?',
           'Which benefit?', 'Play which dynasty?')
ACTION_TYPES = ('draft', 'buy', 'deploy', 'undeploy', 'hire', 'explore',
                'special', 'pass', 'turmoil', 'dynasty', 'resources', 'other')
OWNED_SLOTS = tuple(f'{kind}{index}' for kind, capacity in (
    ('A', 2), ('BM', 6), ('S', 2), ('C', 4), ('W', 6))
    for index in range(1, capacity + 1)) + ('Hire',)
MARKET_SLOTS = tuple(f'P{row}{column}' for row in range(1, 4) for column in range(1, 5))
RESOURCE_CHOICE = re.compile(r'(-?\d+)\s+\[(Food|Stone|Gold|Books?|Military|Stability|Points?|Workers?)\]')
SLOT_PATTERN = re.compile(r'(BM|[ACSW])(\d+)')
ABILITY_CARDS = ('SnTz', 'NcMc', 'GrWl', 'K_KK', 'K_JK')


class PositionEncoder(Encoder):
    def __init__(self, cards):
        super().__init__(cards, 2)
        self.card_by_name = {card['name']: cid for cid, card in cards.items() if 'name' in card}

    @lru_cache(maxsize=1024)
    def card_profile(self, cid):
        card = self.cards.get(cid, {})
        amounts = card.get('amounts', {})
        stages = card.get('stages', [])
        return [
            float(bool(cid)), *[float(card.get('type') == kind) for kind in TYPES],
            *[amounts.get(resource, 0) / 10 for resource in RESOURCES],
            card.get('points', 0) / 5, card.get('deployCost', 0) / 5,
            card.get('military', 0) / 40, card.get('raid', 0) / 10,
            len(stages) / 5, sum(stages) / 15,
            *self.war_penalty(card),
        ]

    @staticmethod
    def war_penalty(card):
        resource = card.get('penaltyResource')
        return [card.get('penalty', 0) / 15 if resource == f'Resource.{r.upper()}' else 0.
                for r in RESOURCES]

    def progress(self, cid, visible):
        card = self.cards.get(cid, {})
        stages = card.get('stages', [])
        complete = visible.get('architects', 0)
        explored = visible.get('explored', 0)
        exploration_turns = visible.get('exploration_turns', 0)
        on_card = visible.get('resources', {})
        return [
            visible.get('deployed', 0) / 6, complete / 5,
            stages[complete] / 5 if complete < len(stages) else 0.,
            explored / 5, exploration_turns / 5,
            visible.get('private', 0) / 3, visible.get('markers', 0) / 6,
            float(bool(visible.get('covered_by'))), float(bool(visible.get('global'))),
            *[amount(on_card, r) / 6 for r in RESOURCES[:3]],
        ]

    def player_profile(self, player):
        slots, visible = player.get('slots', {}), player.get('cards', {})
        profile = [
            float('resources' in player), amount(player.get('resources'), 'Books') / 80,
            *[float(self.uses_card_identity(cid) and (cid in visible or cid in slots.values()))
              for cid in ABILITY_CARDS],
        ]
        for slot in OWNED_SLOTS:
            cid = slots.get(slot)
            profile.extend(self.card_profile(cid))
            profile.extend(self.progress(cid, visible.get(cid, {})))
        return profile

    def state(self, state):
        numbers, tokens = super().state(state)
        actor = state['next_move_player']
        opponent = next(name for name in state['players'] if name != actor)
        own, rival = (state['players'][name] for name in (actor, opponent))
        prompt = policy_prompt(state['next_move_choice'])
        war = self.cards.get(state.get('war'), {})
        threshold = state.get('war_value') or 0
        board = [
            *[float(prompt == kind) for kind in PROMPTS],
            *self.war_penalty(war),
            *[(amount(player.get('resources'), 'Military') - threshold) / 40 if state.get('war') else 0.
              for player in (own, rival)],
            *[(amount(own.get('resources'), r) - amount(rival.get('resources'), r)) / scale
              for r, scale in zip(RESOURCES, (20, 20, 20, 80, 40, 15))],
            *self.player_profile(own), *self.player_profile(rival),
        ]
        market = state.get('progress_board', {})
        for slot in MARKET_SLOTS:
            board.extend(self.card_profile(market.get(slot)))
        return np.concatenate((numbers, np.asarray(board, dtype=np.float32))), tokens

    def encode(self, state):
        legacy, moves = super().encode(state)
        own = state['players'][state['next_move_player']]
        additions = [self.move_profile(state, own, move) for move in moves]
        legacy['an'] = np.concatenate((legacy['an'], np.asarray(additions, dtype=np.float32)), axis=1)
        return legacy, moves

    def move_profile(self, state, player, move):
        slots, visible = player.get('slots', {}), player.get('cards', {})
        turn_action = move.split(' ', 1)[0].lower()
        draft = state.get('nations', {}).get(move)
        target, price, cid = '', 0, None
        quantities = {name: int(value) for value, name in RESOURCE_CHOICE.findall(move)}
        quantities['Books'] = quantities.get('Books', 0) + quantities.get('Book', 0)
        if draft is not None:
            kind = 'draft'
        elif move in ('Pass', 'Turmoil', 'Explore'):
            kind = turn_action
            if kind == 'explore':
                cid = next((cid for cid, info in visible.items() if 'exploration_turns' in info), None)
        elif move.startswith('Buy P') and move[5:].isdigit():
            kind, target = 'buy', move[4:]
            price = int(target[1])
            cid = state.get('progress_board', {}).get(target)
        elif move.startswith(('Deploy to ', 'Undeploy from ')):
            kind, target = turn_action, move.rsplit(' ', 1)[-1]
            cid = slots.get(target)
        elif state['next_move_choice'] in self.placement_prompts and re.fullmatch(r'W[1-6]', move):
            kind, target, cid = 'other', move, slots.get(move)
        elif move.startswith(('Play "', 'Special of "', 'Buy "')):
            kind = {'play': 'dynasty', 'special': 'special', 'buy': 'buy'}[turn_action]
            quoted_name = move.split('"')[1]
            candidates = (*visible, *player.get('dynasties', ()))
            cid = next((key for key in candidates if self.cards.get(key, {}).get('name') == quoted_name),
                       self.card_by_name.get(quoted_name))
        elif move == 'Hire' or move.startswith('Hire from '):
            kind, target = 'hire', 'Hire'
            cid = slots.get(target)
        else:
            kind = 'resources' if quantities else 'other'
        match = SLOT_PATTERN.fullmatch(target)
        target_group, target_number = match.groups() if match else ('', '0')
        return [
            *[float(kind == label) for label in ACTION_TYPES],
            *[float(target_group == group) for group in ('A', 'BM', 'S', 'C', 'W')],
            int(target_number) / 6, price / 3,
            *[quantities.get(label, 0) / 10 for label in RESOURCES],
            (quantities.get('Worker', 0) + quantities.get('Workers', 0)) / 4,
            (quantities.get('Point', 0) + quantities.get('Points', 0)) / 4,
            *self.card_profile(cid), *self.progress(cid, visible.get(cid, {})),
            *self.move_card_features(cid, move),
        ]

    def move_card_features(self, cid, move):
        return ()
