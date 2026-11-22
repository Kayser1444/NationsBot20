"""Canonical public observations and legal placements for interchangeable wonder slots."""
import numpy as np

from ability_encoding import ReplacementAbilityEncoder
from position_encoding import OWNED_SLOTS


SCHEMA = 'current-position-wonder-slots-v1'
WONDER_SLOTS = tuple(slot for slot in OWNED_SLOTS if slot.startswith('W'))
SIX_SLOT_NATIONS = frozenset(('China', 'Poland'))
LOCKED_TYPES = frozenset(('natural-wonder', 'extension'))
PLACEMENTS = frozenset(('Place wonder where?', 'Place natural wonder where?'))


class WonderSlotEncoder(ReplacementAbilityEncoder):
    placement_prompts = PLACEMENTS
    capacity_size = 6

    @staticmethod
    def capacity(player):
        nation = player.get('nation')
        if nation is None:
            return 0
        return 6 if nation in SIX_SLOT_NATIONS else 5

    def slot_counts(self, player):
        total = self.capacity(player)
        slots = player.get('slots', {})
        occupants = [slots[slot] for slot in WONDER_SLOTS if slots.get(slot)]
        replaceable = sum(self.cards.get(cid, {}).get('type') not in LOCKED_TYPES for cid in occupants)
        return total, total - len(occupants), replaceable

    def observation(self, state):
        """Return canonical inputs, a canonical-to-engine move map, and discarded aliases."""
        players, mappings = {}, {}
        for name, player in state['players'].items():
            slots = player.get('slots', {})
            occupied = sorted((slot for slot in WONDER_SLOTS if slots.get(slot)), key=slots.__getitem__)
            ordered = occupied + [slot for slot in WONDER_SLOTS if slot not in occupied]
            mapping = dict(zip(ordered, WONDER_SLOTS))
            normalized = {slot: cid for slot, cid in slots.items() if slot not in mapping}
            normalized.update((mapping[slot], slots[slot]) for slot in occupied)
            mappings[name] = mapping
            players[name] = {**player, 'slots': normalized}

        owner = state['next_move_player']
        options = tuple(state.get('next_move_options', ()))
        physical = state['players'][owner].get('slots', {})
        mapping = mappings[owner]
        aliases = {}
        choices = {}
        prompt = state['next_move_choice']
        if prompt in PLACEMENTS or prompt == 'Place card where?':
            empty = [slot for slot in WONDER_SLOTS[:self.capacity(state['players'][owner])]
                     if slot in options and not physical.get(slot)]
            aliases = {slot: empty[0] for slot in empty[1:]}
            first_empty = next((slot for slot in WONDER_SLOTS if slot not in players[owner]['slots']), None)
            for move in options:
                if move not in aliases:
                    key = first_empty if empty and move == empty[0] else mapping.get(move, move)
                    choices[key] = move
            wonder_moves = iter(sorted(key for key in choices if key in WONDER_SLOTS))
            options = tuple(next(wonder_moves) if key in WONDER_SLOTS else key for key in choices)
        else:
            choices = dict(zip(options, options))
        return {**state, 'players': players, 'next_move_options': options}, choices, aliases

    def move_aliases(self, state):
        if state['next_move_choice'] in PLACEMENTS or state['next_move_choice'] == 'Place card where?':
            return self.observation(state)[2]
        return {}

    def state(self, state):
        normalized, _, _ = self.observation(state)
        numbers, tokens = super().state(normalized)
        owner = state['next_move_player']
        rival = next(name for name in state['players'] if name != owner)
        counts = [n / len(WONDER_SLOTS) for name in (owner, rival)
                  for n in self.slot_counts(state['players'][name])]
        return np.concatenate((numbers, np.asarray(counts, dtype=np.float32))), tokens

    def encode(self, state):
        normalized, choices, _ = self.observation(state)
        features, moves = super().encode(normalized)
        return features, [choices[move] for move in moves]
