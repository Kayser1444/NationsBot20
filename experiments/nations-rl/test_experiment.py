"""Offline regression checks for observation safety and the learning loop."""
from collections import Counter
from copy import deepcopy
import gzip
from io import BytesIO
import json
import random
import unittest

import numpy as np
import torch

from ability_encoding import AbilityEncoder, ReplacementAbilityEncoder
from encoding import Encoder, token
from batch import batches_without_improvement, four_summary, make_training_jobs, paired_points
from mixed_encoding import MixedSettingsEncoder
from mixed_rules import rules_for_board
from model import PolicyValue, collate, initialize_four_player, load_model, save_model
from train import board_seed, ppo_update, read_corpus, seed_all, summarize, value_target
from wonder_encoding import WonderSlotEncoder


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

    def test_mixed_rules_balance_settings_and_omit_disabled_flags(self):
        boards = [rules_for_board(101, index) for index in range(30)]
        self.assertEqual(boards, [rules_for_board(101, index) for index in range(30)])
        self.assertEqual(Counter(row['growth_resources'] for row in boards), {1: 9, 2: 9, 3: 9, 4: 3})
        self.assertEqual(Counter(row['extra_draft_nations'] for row in boards), {0: 10, 1: 10, 2: 10})
        for flag, enabled in (('weighted_card_draw', 21), ('korea_nerf', 15), ('lincoln_nerf', 15)):
            self.assertEqual([row[flag] for row in boards if flag in row], [True] * enabled)
        for row in boards:
            self.assertIs(row['resource_remainder_tiebreaker'], True)
            self.assertNotIn('card_draw_limits', row)

    def test_mixed_encoder_exposes_only_visible_variants(self):
        cards = {'AhLc': {'type': 'advisor', 'name': 'Abraham Lincoln', 'description': 'Special'}}
        encoder = MixedSettingsEncoder(cards)
        state = position()
        state.update(growth_allowances={'Alice': 1, 'Bob': 3}, weighted_card_draw=True)
        legacy, moves = WonderSlotEncoder(cards).encode(state)
        original, mixed_moves = encoder.encode(state)
        self.assertEqual(moves, mixed_moves)
        np.testing.assert_array_equal(original['sn'][:len(legacy['sn'])], legacy['sn'])
        np.testing.assert_array_equal(original['an'][:, :legacy['an'].shape[-1]], legacy['an'])
        extra = len(legacy['sn'])
        np.testing.assert_array_equal(original['sn'][extra:extra + 3], [.25, .75, 1])
        state.update(korea_nerf=True, lincoln_nerf=True, extra_draft_nations=2)
        hidden, _ = encoder.encode(state)
        for key in original:
            np.testing.assert_array_equal(hidden[key], original[key])

        state['players']['Alice']['slots'] = {'S1': 'K_S_Nerf'}
        state['progress_board']['P11'] = 'AhLc_Nerf'
        visible, _ = encoder.encode(state)
        np.testing.assert_array_equal(visible['sn'][extra + 3:extra + 5], [0, 1])
        self.assertEqual(np.count_nonzero(visible['sn'][extra + 11:]), 1)
        np.testing.assert_array_equal(visible['an'][0, -4:-2], [0, 1])

        state.update(next_move_choice='Draft which nation?', next_move_options=['Korea', 'Rome'],
                     nations={'Korea': {'slots': {'S1': 'K_S_Nerf'}}, 'Rome': {'slots': {}}})
        draft, draft_moves = encoder.encode(state)
        np.testing.assert_array_equal(draft['an'][draft_moves.index('Korea'), -2:], [0, 1])
        np.testing.assert_array_equal(draft['an'][draft_moves.index('Rome'), -2:], [0, 0])

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

    def test_replacement_abilities_remove_legacy_identities_and_preserve_facts(self):
        cards = {
            'Ptr': {'type': 'wonder', 'name': 'Petra', 'description': 'Action', 'stages': [2, 0, 1]},
            'Unb': {'type': 'wonder', 'name': 'Uraniborg', 'goldenAgeBonus': 2},
            'GrWl': {'type': 'wonder', 'name': 'Great Wall', 'description': 'Pass first', 'points': 1},
            'K_JK': {'type': 'dynasty', 'name': 'Joseon Kingdom', 'description': 'Action'},
        }
        state = position()
        state['progress_board']['P11'] = 'GrWl'
        state['next_move_options'] = ['Buy P11', 'Hire from "Uraniborg"', 'Play "Joseon Kingdom"',
                                      'Joseon Kingdom', 'Pass']
        state['players']['Alice'].update(slots={'Hire': 'Ptr', 'W1': 'Unb'}, dynasties=['K_JK'])
        state['players']['Bob'].update(slots={'W1': 'GrWl'}, cards={'GrWl': {'global': 1}})
        original = AbilityEncoder(cards)
        replacement = ReplacementAbilityEncoder(cards)
        old, old_moves = original.encode(state)
        new, new_moves = replacement.encode(state)
        self.assertEqual(new_moves, old_moves)
        for label in ('self/slot/Hire/Ptr', 'self/card/Ptr', 'self/deployed/Ptr/0',
                      'self/dynasty/K_JK', 'market/P11/GrWl'):
            self.assertIn(token(label), old['st'])
            self.assertNotIn(token(label), new['st'])
        action_tokens = ('card/GrWl', 'move/Hire from "Uraniborg"', 'move/Play "Joseon Kingdom"', 'move/Joseon Kingdom')
        for index, label in enumerate(action_tokens):
            self.assertIn(token(label), old['at'][index])
            self.assertNotIn(token(label), new['at'][index])
        np.testing.assert_array_equal(new['an'][:, :-len(cards)], old['an'][:, :-len(cards)])
        self.assertEqual(np.count_nonzero(new['sn'] - old['sn']), 1)  # Legacy Great Wall indicator.
        for card in ('Ptr', 'Unb'):
            self.assertEqual(new['an'][1, -len(cards) + replacement.ability_index[card]], 1)
        self.assertEqual(new['an'][3, -len(cards) + replacement.ability_index['K_JK']], 1)

    def test_wonder_slot_permutations_produce_identical_model_inputs_and_scores(self):
        cards = {'Vsv': {'type': 'natural-wonder', 'description': 'Return a worker',
                         'amounts': {'Food': 1}}}
        encoder = WonderSlotEncoder(cards)
        state = position()
        state['players']['Alice']['slots'] = {'W1': 'Vsv'}
        original, moves = encoder.encode(state)
        model = PolicyValue(len(original['sn']), original['an'].shape[-1]).eval()
        for index in range(2, 6):
            variant = deepcopy(state)
            variant['players']['Alice']['slots'] = {f'W{index}': 'Vsv'}
            normalized, translated_moves = encoder.encode(variant)
            self.assertEqual(translated_moves, moves)
            for key in original:
                np.testing.assert_array_equal(normalized[key], original[key])
            with torch.no_grad():
                for expected, actual in zip(model(collate([original])), model(collate([normalized]))):
                    torch.testing.assert_close(actual, expected, atol=0, rtol=0)

    def test_wonder_placements_merge_empty_slots_and_preserve_occupied_targets(self):
        cards = {
            'A': {'type': 'wonder', 'amounts': {'Food': 1}},
            'Z': {'type': 'wonder', 'amounts': {'Gold': 1}},
            'Vsv': {'type': 'natural-wonder', 'description': 'Return a worker'},
        }
        encoder = WonderSlotEncoder(cards)
        state = position()
        state['players']['Alice'].update(nation='China', slots={'W2': 'A', 'W5': 'Z', 'W6': 'Vsv'})
        state['next_move_choice'] = 'Place natural wonder where?'
        state['next_move_options'] = ['W1', 'W2', 'W3', 'W4', 'W5']
        variant = deepcopy(state)
        variant['players']['Alice']['slots'] = {'W5': 'A', 'W1': 'Z', 'W2': 'Vsv'}
        variant['next_move_options'] = ['W1', 'W3', 'W4', 'W5', 'W6']
        original, moves = encoder.encode(state)
        normalized, translated_moves = encoder.encode(variant)
        self.assertTrue(encoder.supports(state))
        self.assertEqual(moves, ['W2', 'W5', 'W1'])
        self.assertEqual(translated_moves, ['W5', 'W1', 'W3'])
        self.assertEqual(encoder.move_aliases(state), {'W3': 'W1', 'W4': 'W1'})
        self.assertEqual(encoder.move_aliases(variant), {'W4': 'W3', 'W6': 'W3'})
        for key in original:
            np.testing.assert_array_equal(normalized[key], original[key])
        self.assertEqual(encoder.slot_counts(state['players']['Alice']), (6, 3, 2))
        self.assertEqual(encoder.slot_counts({'nation': 'Rome'}), (5, 5, 0))
        np.testing.assert_allclose(original['sn'][-6:-3], np.array([6, 3, 2]) / 6)
        self.assertEqual(state['players']['Alice']['slots'], {'W2': 'A', 'W5': 'Z', 'W6': 'Vsv'})

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

    def test_four_player_transfer_copies_shared_features_and_sees_each_rival(self):
        state = position()
        state['players'].update({'C': {'score': 7}, 'D': {'score': 8}})
        state['player_order'].extend(('C', 'D'))
        encoder = Encoder(self.encoder.cards, 4)
        features, moves = encoder.encode(state)
        np.testing.assert_array_equal(features['sn'][:60], self.features['sn'])
        np.testing.assert_array_equal(features['an'], self.features['an'])
        self.assertEqual(moves, ['Buy P11', 'Pass'])
        state['players'] = dict(reversed(list(state['players'].items())))
        reordered, _ = encoder.encode(state)
        np.testing.assert_array_equal(features['sn'], reordered['sn'])
        for rival in ('Bob', 'C', 'D'):
            changed = deepcopy(state)
            changed['players'][rival]['score'] = 16
            self.assertFalse(np.array_equal(features['sn'], encoder.encode(changed)[0]['sn']))
        source = self.model()
        model = PolicyValue(len(features['sn']), features['an'].shape[-1], 4)
        value_weights = model.value[0].weight.detach().clone()
        initialize_four_player(model, source)
        torch.testing.assert_close(model.action[0].weight, source.action[0].weight)
        torch.testing.assert_close(model.value[0].weight, value_weights)
        self.assertEqual(torch.count_nonzero(model.context[0].weight[:, 60:-24]).item(), 0)

    def test_four_player_rotations_and_paired_league_points(self):
        jobs = make_training_jobs({'players': 4, 'seed': 5}, {'episode': 0, 'pool': ['older.pt']}, 16,
                                  random.Random(5), lambda prefix, i: f'{prefix}-{i}')
        for kind in ('self-play', 'baseline', 'history'):
            self.assertEqual({job['actor'] for job in jobs if job['kind'] == kind},
                             {f'Seat{seat}' for seat in range(4)})
        self.assertTrue(all(len(job['opponents']) == 3 for job in jobs))
        self.assertEqual([value_target(rank, 4) for rank in range(1, 5)], [1, .5, .25, 0])
        rows = [{'seed': 'x', 'candidate': f'Seat{seat}', 'ranks': {f'Seat{seat}': seat + 1},
                 'error': None} for seat in range(4)]
        self.assertEqual(four_summary(rows)['mean_league_points'], 2.75)
        failed = [dict(row, error='limit') if row['candidate'] == 'Seat0' else row for row in rows]
        self.assertEqual(four_summary(failed)['placements'], [0, 1, 1, 1])
        self.assertEqual(paired_points(rows, failed)['mean_gain'], -1)

    def test_patience_counts_ties_and_resets_only_on_a_new_high(self):
        checkpoints = ['start.pt', 'games-001000.pt', 'games-002000.pt', 'games-003000.pt', 'games-004000.pt']
        points = [3.0, 3.0, 3.25, 3.10, 3.25]
        reports = {f'monitor-{name[:-3]}': {'mean_league_points': score}
                   for name, score in zip(checkpoints, points)}
        self.assertEqual([batches_without_improvement(checkpoints[:size], reports)
                          for size in range(1, 6)], [0, 1, 0, 1, 2])


if __name__ == '__main__':
    unittest.main()
