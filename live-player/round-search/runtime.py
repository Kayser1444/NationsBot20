"""Score a public action prompt using the frozen 100K policy and round scorer."""
import json
from math import erf, sqrt
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import numpy as np

from mixed_encoding import MixedSettingsEncoder
from nations_public_round import PublicTurns, public_rollout
from nations_round_search import search_round


ROOT = Path(__file__).resolve().parent
CONFIRMATIONS = ('Confirm', 'Confirm and complete the turn now')


def observation(match):
    return {**match.get_state(), 'weighted_card_draw': match.weighted_card_draw,
            'resource_tiebreak': match.resource_remainder_tiebreaker,
            'growth_allowances': {p.name: p.growth_resources for p in match.players}}


class RoundEncoder(MixedSettingsEncoder):
    def settled(self, state, owner):
        normalized, _, _ = self.observation({**state, 'next_move_player': owner, 'next_move_choice': '',
                                             'next_move_options': ()})
        rival = next(name for name in state['players'] if name != owner)
        features = [state['round'] / 8, float(state['player_order'][0] == owner),
                    float(state['resource_tiebreak']), float(state['weighted_card_draw'])]
        for name in (owner, rival):
            player = normalized['players'][name]
            features.extend(self.player_numbers({**player, 'passed': 0}))
            features.extend((state['growth_allowances'][name] / 4, player['resource_remainder'] / 10,
                             sum(bool(card) for card in player['dynasties']) / 4))
            features.extend(self.player_profile(player))
            features.extend(self.player_abilities(player))
        return np.asarray(features, dtype=np.float32)


def gelu(vector):
    return vector * np.array([.5 * (1 + erf(float(x) / sqrt(2))) for x in vector], dtype=np.float32)


class Runtime:
    def __init__(self):
        with np.load(ROOT / 'weights.npz', allow_pickle=False) as data:
            self.weights = dict(data)
        self.encoder = RoundEncoder(json.loads((ROOT / 'card-index.json').read_text(encoding='utf-8')))
        self.fallback = subprocess.Popen(['node', str(ROOT / 'fallback.mjs')], stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, encoding='utf-8')

    def dense(self, layer, inputs):
        return inputs @ self.weights[layer + '.weight'].T + self.weights[layer + '.bias']

    def pool(self, name, tokens):
        return self.weights[name + '_embedding.weight'][tokens].sum(axis=-2) / np.sqrt(
            np.count_nonzero(tokens, axis=-1).clip(1).astype(np.float32))[..., None]

    def predict(self, state):
        aliases = self.encoder.move_aliases(state)
        options = state['next_move_options']
        confirm = next((move for move in CONFIRMATIONS if move in options), None)
        if confirm or not self.encoder.supports(state):
            menu = {**state, 'next_move_options': [move for move in options if move not in CONFIRMATIONS]}
            self.fallback.stdin.write(json.dumps(menu) + '\n')
            self.fallback.stdin.flush()
            moves = [confirm] if confirm else []
            moves.extend(aliases.get(move, move) for move in json.loads(self.fallback.stdout.readline()))
            return {'moves': [{'move': move} for move in dict.fromkeys(moves)], 'move_aliases': aliases}
        data, moves = self.encoder.encode(state)
        context = np.tanh(self.dense('context.0', np.concatenate((data['sn'], self.pool('state', data['st'])))))
        actions = np.tanh(self.dense('action.0', np.concatenate((data['an'], self.pool('action', data['at'])), axis=1)))
        features = np.concatenate((np.broadcast_to(context, (len(moves), len(context))), actions), axis=1)
        scores = self.dense('policy.2', np.tanh(self.dense('policy.0', features))).ravel()
        order = np.argsort(-scores, kind='stable')
        top = scores[order[0]]
        return {'moves': [{'move': moves[i], 'policy_gap': float(top - scores[i])} for i in order],
                'move_aliases': aliases}

    def evaluate(self, state, owner):
        if state['round'] == 8:
            rival = next(name for name in state['players'] if name != owner)
            remainder = state['players'][owner]['resource_remainder'] - state['players'][rival]['resource_remainder']
            return state['final_winner'] == owner, state['final_margin'], remainder if state['resource_tiebreak'] else 0
        x = self.dense('round.0', self.encoder.settled(state, owner))
        x = (x - x.mean()) / np.sqrt(x.var() + 1e-5)
        x = gelu(x * self.weights['round.1.weight'] + self.weights['round.1.bias'])
        return float(self.dense('round.6', gelu(self.dense('round.4', x)))[0]),

    def select(self, request):
        rules = {name: True for name, enabled in request['rules'].items() if enabled}
        state = request['state']
        turns = PublicTurns()
        for entry in (*request['history'], request['root']):
            turns.observe(entry['state'], entry['log'])

        def rollout(_replay, public, prefix, predict, branch, deadline, *, observe):
            return public_rollout(public, turns, rules, prefix, predict, branch, deadline, observe=observe)

        position = SimpleNamespace(get_replay=lambda: '')
        move, counts, _ = search_round(position, state, state['next_move_options'], self.predict,
                                       self.predict(state), value_score=self.evaluate, observe=observation,
                                       rollout=rollout)
        return {'move': move if counts['compared'] else None, 'compared': bool(counts['compared']),
                'trusted': turns.trusted, 'counts': counts, 'actions': turns.remaining.get(turns.actor)}


if __name__ == '__main__':
    runtime = Runtime()
    try:
        for line in sys.stdin:
            try:
                reply = runtime.select(json.loads(line))
            except Exception as error:
                reply = {'move': None, 'error': type(error).__name__}
            print(json.dumps(reply, allow_nan=False), flush=True)
    finally:
        runtime.fallback.stdin.close()
        runtime.fallback.wait(timeout=3)
