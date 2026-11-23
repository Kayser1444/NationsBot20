"""Versioned, public-observation-only features for the isolated two-player pilot.

No replay metadata, names, move number, seed, RNG, deck or terminal outcome is
accepted as a feature. Both corpus positions and live engine positions take
this same path. Unknown fields are ignored rather than recursively encoded.
"""
from functools import lru_cache
from hashlib import blake2b
import re

import numpy as np

VERSION = 1
BUCKETS = 4096
STATE_TOKENS = 128
ACTION_TOKENS = 16
RESOURCES = ('Food', 'Stone', 'Gold', 'Books', 'Military', 'Stability')
TYPES = ('building', 'military', 'advisor', 'colony', 'wonder', 'natural-wonder',
         'battle', 'golden-age', 'war')
SUPPORTED = frozenset(('Draft which nation?', 'Take what for growth?', 'Which action?',
                       'Which benefit?', 'Play which dynasty?'))
EXCLUDED = frozenset(('UNDO', 'Resign', 'Confirm', 'Confirm and complete the turn now'))


@lru_cache(maxsize=50000)
def token(text):
    return 1 + int.from_bytes(blake2b(text.encode(), digest_size=8).digest(), 'little') % (BUCKETS - 1)


def ids(tokens, size):
    if len(tokens) > size:
        raise ValueError(f'Feature token capacity exceeded: {len(tokens)} > {size}')
    return np.asarray([token(t) for t in tokens] + [0] * (size - len(tokens)), dtype=np.int32)


def scaled(value, scale=10):
    return max(-3., min(3., float(value or 0) / scale))


def amount(fields, resource):
    return (fields or {}).get(f'[{resource}]', 0)


def legal_moves(state):
    return [str(move) for move in state.get('next_move_options', ()) if str(move) not in EXCLUDED]


class Encoder:
    placement_prompts = frozenset()

    def __init__(self, cards, player_count=2):
        self.player_count = player_count
        self.cards = cards

    def supports(self, state):
        return state['next_move_choice'] in SUPPORTED or state['next_move_choice'] in self.placement_prompts

    def move_aliases(self, state):
        return {}

    def card_numbers(self, card):
        return ([scaled(card.get(key), scale) for key, scale in (
            ('age', 4), ('points', 5), ('deployCost', 5), ('military', 10),
            ('raid', 5), ('famine', 5), ('penalty', 10), ('privateArchitects', 3),
            ('goldenAgeBonus', 5))]
            + [scaled(card.get('amounts', {}).get(r), 5) for r in RESOURCES]
            + [float(card.get('type') == kind) for kind in TYPES]
            + [scaled(sum(card.get('stages', [])), 10), scaled(len(card.get('stages', [])), 4)])

    def player_numbers(self, player):
        return ([scaled(amount(player.get('resources'), r), 20) for r in RESOURCES]
                + [scaled(amount(player.get('production'), r), 10) for r in RESOURCES]
                + [scaled(player.get(key), scale) for key, scale in (
                    ('workers', 8), ('grown_workers', 8), ('points', 30), ('score', 40), ('passed', 1))]
                + [scaled(sum(self.cards.get(cid, {}).get('type') == kind
                              for cid in player.get('slots', {}).values()), 5) for kind in TYPES])

    def uses_card_identity(self, cid):
        return True

    def move_token(self, move):
        return move

    def state(self, state):
        players = state.get('players', {})
        who = state['next_move_player']
        if len(players) != self.player_count or who not in players:
            raise ValueError(f'Expected a {self.player_count}-player acting-player observation')
        order = state.get('player_order', [])
        numbers = [scaled(state.get('round'), 8), scaled(state.get('architects'), 5),
                   scaled(state.get('turmoil'), 5), scaled(state.get('war_value'), 15),
                   float(bool(state.get('war'))), float(order.index(who) == 0) if who in order else 0.,
                   scaled(len(legal_moves(state)), 20)]
        tokens = [f"prompt/{state.get('next_move_choice')}", f"event/{state.get('event')}",
                  f"war/{state.get('war')}"]
        seats = [name for name in order if name in players]
        seats.extend(name for name in players if name not in seats)
        pivot = seats.index(who)
        seats = seats[pivot:] + seats[:pivot]
        extra = []
        for index, name in enumerate(seats):
            role = 'self' if index == 0 else 'rival'
            player = players[name]
            (numbers if index < 2 else extra).extend(self.player_numbers(player))
            tokens.append(f"{role}/nation/{player.get('nation')}")
            for slot, cid in sorted(player.get('slots', {}).items()):
                if not self.uses_card_identity(cid):
                    continue
                tokens.extend((f'{role}/slot/{slot}/{cid}', f'{role}/card/{cid}'))
                deployed = player.get('cards', {}).get(cid, {}).get('deployed', 0)
                tokens.append(f'{role}/deployed/{cid}/{deployed}')
            for cid in player.get('dynasties', []):
                if cid and self.uses_card_identity(cid):
                    tokens.append(f'{role}/dynasty/{cid}')
        for slot, cid in sorted(state.get('progress_board', {}).items()):
            if self.uses_card_identity(cid):
                tokens.append(f'market/{slot}/{cid}')
        for nation in sorted(state.get('nations', {})):
            tokens.append(f'available/{nation}')
        event = self.cards.get(state.get('event'), {})
        numbers.append(scaled(event.get('famine'), 5))
        if self.player_count == 4:
            numbers.extend(extra)
            numbers.append(pivot / 3)
        return np.asarray(numbers, dtype=np.float32), ids(tokens, STATE_TOKENS if self.player_count == 2 else 512)

    def action(self, state, move):
        player = state['players'][state['next_move_player']]
        prompt = state['next_move_choice']
        cid, kind, price, deployed = None, 'other', 0, 0
        draft = state.get('nations', {}).get(move)
        if draft is not None:
            kind = 'draft'
        elif re.fullmatch(r'Buy P\d+', move):
            kind = 'buy'
            slot = move.split()[1]
            cid = state.get('progress_board', {}).get(slot)
            price = int(slot[1])
        elif move.startswith(('Deploy to ', 'Undeploy from ')):
            kind = 'undeploy' if move.startswith('Undeploy') else 'deploy'
            cid = player.get('slots', {}).get(move.split()[-1])
        elif prompt == 'Take what for growth?':
            kind = 'growth'
        elif move.startswith('Hire'):
            kind, cid = 'hire', player.get('slots', {}).get('Hire')
        elif move == 'Pass':
            kind = 'pass'
        elif move == 'Turmoil':
            kind = 'turmoil'
        elif move.startswith('Play '):
            kind = 'dynasty'
            cid = next((c for c in player.get('dynasties', [])
                        if c and self.cards.get(c, {}).get('name', '') in move), None)
        elif move.startswith('Special of '):
            kind = 'special'
        card = self.cards.get(cid, {})
        deployed = player.get('cards', {}).get(cid, {}).get('deployed', 0)
        # The exact move token represents a public legal choice, never a player name.
        tokens = [f'kind/{kind}', f'move/{self.move_token(move)}', f'prompt-kind/{prompt}/{kind}',
                  f"type/{card.get('type')}"]
        if cid and self.uses_card_identity(cid):
            tokens.extend((f'card/{cid}', f'{kind}/card/{cid}'))
        if draft is not None:
            tokens.append(f'nation/{move}')
        numbers = [scaled(price, 3), scaled(deployed, 5), float('[Worker]' in move)]
        numbers.extend(self.card_numbers(card))
        numbers.extend(self.player_numbers(draft or {}))
        for r in RESOURCES:
            numbers.append(float(f'[{r}]' in move))
        if draft:
            # Initial buildings and military are printed public nation information.
            output = [sum(self.cards.get(c, {}).get('amounts', {}).get(r, 0)
                          for c in draft.get('slots', {}).values()) for r in RESOURCES]
        else:
            output = [0] * len(RESOURCES)
        numbers.extend(scaled(v, 8) for v in output)
        return np.asarray(numbers, dtype=np.float32), ids(tokens, ACTION_TOKENS)

    def encode(self, state):
        sn, st = self.state(state)
        moves = legal_moves(state)
        if not moves:
            raise ValueError('No non-administrative legal choices')
        actions = [self.action(state, move) for move in moves]
        return {'sn': sn, 'st': st, 'an': np.stack([x[0] for x in actions]),
                'at': np.stack([x[1] for x in actions])}, moves
