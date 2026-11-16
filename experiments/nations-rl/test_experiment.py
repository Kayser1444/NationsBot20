"""Offline regression checks for observation safety and the learning loop."""
from copy import deepcopy
import gzip
from io import BytesIO
import json
import random
import unittest

import numpy as np
import torch

from encoding import Encoder
from model import PolicyValue, collate, load_model, save_model
from train import board_seed, ppo_update, read_corpus, seed_all, summarize


def position():
    return {'round': 2, 'next_move_player': 'Alice', 'next_move_choice': 'Which action?',
            'next_move_options': ['Buy P11', 'Pass', 'UNDO', 'Resign'],
            'player_order': ['Alice', 'Bob'], 'players': {
                'Alice': {'nation': 'Rome', 'resources': {'[Gold]': 5}, 'score': 10},
                'Bob': {'nation': 'China', 'resources': {'[Gold]': 4}, 'score': 12}},
            'progress_board': {'P11': 'F'}, 'event': None, 'nations': {}}


class LearningTests(unittest.TestCase):
    def setUp(self):
        seed_all(73, 1)
        self.encoder = Encoder({'F': {'type': 'building', 'amounts': {'Food': 3}, 'deployCost': 1}})
        self.features, _ = self.encoder.encode(position())

    def model(self):
        return PolicyValue(len(self.features['sn']), self.features['an'].shape[-1])

    def test_observation_ignores_outcomes_seeds_names_and_unknown_engine_fields(self):
        state = position()
        state.update(seed='secret', rank=1, chosen='Pass', move_number=9999,
                     deck=['secret'], rng='private', match='other', winner='Alice')
        state['players']['Alice']['future_score'] = 900
        state['players']['Bob']['private_hand'] = ['unknown']
        state['players'] = {'Seat0': state['players']['Alice'], 'Seat1': state['players']['Bob']}
        state['next_move_player'] = 'Seat0'
        state['player_order'] = ['Seat0', 'Seat1']
        encoded, moves = self.encoder.encode(state)
        self.assertEqual(moves, ['Buy P11', 'Pass'])
        for key in encoded:
            np.testing.assert_array_equal(encoded[key], self.features[key])

    def test_padding_does_not_change_policy_or_value(self):
        model = self.model().eval()
        smaller = {k: v[:1] if k in ('an', 'at') else v for k, v in self.features.items()}
        with torch.no_grad():
            single, value = model(collate([smaller]))
            batched, values = model(collate([smaller, self.features]))
        torch.testing.assert_close(single[0, 0], batched[0, 0])
        torch.testing.assert_close(value[0], values[0])
        self.assertEqual(batched[0].softmax(-1)[1].item(), 0.)

    def test_supervised_training_learns_policy_and_win_value_and_roundtrips(self):
        model = self.model()
        batch = collate([self.features])
        optimizer = torch.optim.Adam(model.parameters(), lr=.02)
        for _ in range(30):
            policy, value = model(batch)
            loss = torch.nn.functional.cross_entropy(policy, torch.tensor([1])) + torch.nn.functional.binary_cross_entropy_with_logits(value, torch.ones(1))
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        self.assertGreater(policy.softmax(-1)[0, 1].item(), .95)
        self.assertGreater(value.sigmoid().item(), .95)
        checkpoint = BytesIO()
        save_model(checkpoint, model, {'kind': 'test'})
        checkpoint.seek(0)
        loaded, _ = load_model(checkpoint)
        for left, right in zip(model.parameters(), loaded.parameters()):
            torch.testing.assert_close(left, right)

    def test_ppo_updates_parameters_from_complete_outcomes(self):
        model = self.model()
        anchor = deepcopy(model)
        rows = []
        with torch.no_grad():
            logits, value = model(collate([self.features]))
        for label, target in ((0, 0.), (1, 1.)):
            rows.append(dict(self.features, label=label, target=target,
                             old_logprob=logits.log_softmax(-1)[0, label].item(), old_value=value.sigmoid().item()))
        before = deepcopy(model.state_dict())
        result = ppo_update(model, anchor, rows, torch.optim.Adam(model.parameters(), lr=.001), random.Random(3))
        self.assertEqual(result['samples'], 2)
        self.assertTrue(all(np.isfinite(v) for v in result.values()))
        self.assertTrue(any(not torch.equal(before[k], v) for k, v in model.state_dict().items()))

    def test_reservoir_filters_four_players_and_keeps_outcomes_out_of_features(self):
        rows = [{'match': i, 'phase': 'action', 'rank': i % 2 + 1, 'chosen': 'Pass', 'state': position()} for i in range(20)]
        extra = deepcopy(rows[0])
        extra['state']['players'].update({'C': {}, 'D': {}})
        rows.append(extra)
        corpus = BytesIO(gzip.compress(''.join(json.dumps(row) + '\n' for row in rows).encode('utf-8')))
        sampled, games, info = read_corpus(corpus, self.encoder, 8, random.Random(3))
        self.assertEqual(len(sampled), 8)
        self.assertEqual(len(games), 20)
        self.assertEqual(info['available_decisions'], 20)
        for row in sampled:
            np.testing.assert_array_equal(row['sn'], self.features['sn'])

    def test_failures_count_as_non_wins_and_seeds_do_not_overlap(self):
        rows = [{'seed': 'x', 'candidate': 'Seat0', 'opponent': 'Seat1', 'error': None,
                 'rewards': {'Seat0': 1.}, 'scores': {'Seat0': 20, 'Seat1': 10}},
                {'seed': 'x', 'candidate': 'Seat1', 'opponent': 'Seat0', 'error': 'limit'}]
        result = summarize(rows)
        self.assertEqual(result['attempted'], 2)
        self.assertEqual(result['completed'], 1)
        self.assertEqual(result['win_rate_all_attempts'], .5)
        self.assertNotEqual(board_seed('training', 3, 0), board_seed('evaluation', 3, 0))


if __name__ == '__main__':
    unittest.main()
