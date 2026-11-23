"""Public special-ability inputs for direct policy training."""
import re

import numpy as np

from position_encoding import PositionEncoder


SCHEMA = 'current-position-abilities-v1'
REPLACEMENT_SCHEMA = 'current-position-abilities-replacement-v1'
ABILITY_TYPES = frozenset(('advisor', 'dynasty', 'wonder', 'natural-wonder'))
QUOTED_NAME = re.compile(r'"([^"]+)"')


class AbilityEncoder(PositionEncoder):
    def __init__(self, cards):
        super().__init__(cards)
        self.ability_ids = tuple(sorted(
            cid for cid, card in cards.items()
            if card.get('type') in ABILITY_TYPES
            and (card.get('description') or card.get('privateArchitects') or card.get('goldenAgeBonus'))
        ))
        self.ability_index = {cid: index for index, cid in enumerate(self.ability_ids)}
        self.ability_vectors = np.eye(len(self.ability_ids), dtype=np.float32)
        self.no_ability = np.zeros(len(self.ability_ids), dtype=np.float32)
        self.extra_state_size = 2 * len(self.player_abilities({})) + len(self.ability_ids) + 2

    def index(self, cid):
        # The frozen rules use the nerfed variant under a different engine ID.
        return self.ability_index.get('AhLc' if cid == 'AhLc_Nerf' else cid)

    def player_abilities(self, player):
        cards = player.get('cards', {})
        slots = player.get('slots', {})
        unplayed = set(player.get('dynasties', ()))
        pending = set()
        cid = slots.get('Hire')
        while cid and cid not in pending:
            pending.add(cid)
            cid = cards.get(cid, {}).get('covered_by')
        flags = np.zeros((3, len(self.ability_ids)), dtype=np.float32)
        for cid in cards.keys() | slots.values():
            index = self.index(cid)
            if index is None or cid in unplayed:
                continue
            if cid in pending:
                flags[1, index] = 1
            else:
                flags[0, index] = 1
                flags[2, index] = bool(cards.get(cid, {}).get('global'))
        return flags.ravel()

    def state(self, state):
        numbers, tokens = super().state(state)
        actor = state['next_move_player']
        players = state['players']
        own = players[actor]
        rival = next(player for name, player in players.items() if name != actor)
        offered = np.zeros(len(self.ability_ids), dtype=np.float32)
        for move in state.get('next_move_options', ()):
            if move.startswith('Special of "'):
                cid = self.card_by_name.get(move.split('"')[1])
                index = self.index(cid)
                if index is not None:
                    offered[index] = 1
        pass_order = np.asarray([own.get('passed_first', 0), rival.get('passed_first', 0)], dtype=np.float32)
        return np.concatenate((numbers, self.player_abilities(own), self.player_abilities(rival),
                               offered, pass_order)), tokens

    def move_card_features(self, cid, move):
        index = self.index(cid)
        return self.no_ability if index is None else self.ability_vectors[index]


class ReplacementAbilityEncoder(AbilityEncoder):
    def uses_card_identity(self, cid):
        return self.index(cid) is None

    def move_token(self, move):
        if not self.uses_card_identity(self.card_by_name.get(move)):
            return 'Card'
        return QUOTED_NAME.sub(
            lambda match: match[0] if self.uses_card_identity(self.card_by_name.get(match[1])) else '"Card"',
            move,
        )

    def move_card_features(self, cid, move):
        flags = super().move_card_features(cid, move)
        for name in [move, *QUOTED_NAME.findall(move)]:
            index = self.index(self.card_by_name.get(name))
            if index is not None and not flags[index]:
                flags = flags.copy()
                flags[index] = 1
        return flags
