"""Exercise the chance boundary and deterministic branching in the real engine."""
from pathlib import Path
import sys
from time import perf_counter
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from nations_lookahead import SearchBoundary, Transition, branch, explore, lock_hidden_information
from nations_microsearch import (Position, SearchPositions, search, search_best_first,
                                 search_broad_best_first, search_policy_rollouts, search_pre_move, trace)
from nations_microsearch import ranked_choices
from nations_round_search import RoundLine, RoundSearchMemory, rollout_round, search_round
from nations_move_safety import FREE_ARCHITECT, QIN_DYNASTY, safe_architect_options

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'nations-server/Nations'))
from nations import Match
from nations.actions import PassAction
from nations_public_round import PublicPositionUnavailable, PublicTurns, public_rollout


class PublicDecisionFixture(Exception):
    pass


def position_at(predicate, rules=None):
    class Stop(Exception):
        pass

    def choose(prompt, options, _undo):
        if predicate(match, prompt):
            raise Stop()
        legal = {str(option): option for option in options if str(option) not in ('UNDO', 'Resign')}
        for move in ('Confirm', 'Pass', '2 [Gold]'):
            if move in legal:
                return legal[move]
        return next(iter(legal.values()))

    match = Match(player_names=['A', 'B'], seed='0194', move_getter=choose,
                  rules={'extra_draft_nations': 1} if rules is None else rules)
    try:
        match.play()
    except Stop:
        return match
    raise AssertionError('Fixture never reached the requested decision')


class SearchTests(unittest.TestCase):
    def test_public_round_matches_the_engine_and_abstains_after_missing_a_decision(self):
        turns = PublicTurns()

        def observation(game):
            return {**game.get_state(),
                    'growth_allowances': {p.name: p.growth_resources for p in game.players},
                    'weighted_card_draw': game.weighted_card_draw,
                    'resource_tiebreak': game.resource_remainder_tiebreaker}

        def stop_at_main(game, prompt):
            turns.observe(observation(game), game.get_log())
            return prompt == 'Which action?'

        def predict(state):
            options = state['next_move_options']
            choice = next((move for move in ('Pass', 'Confirm') if move in options), options[0])
            return {'moves': [{'move': choice}]}

        game = position_at(stop_at_main)
        state = observation(game)
        path = ('Pass',)
        oracle = rollout_round(game.get_replay(), state, path, predict, lambda *_: None, perf_counter() + 5,
                               observe=observation)
        result = public_rollout(state, turns, {}, path, predict, lambda *_: None, perf_counter() + 5,
                                observe=observation)
        self.assertEqual(result['rollout_moves'], oracle['rollout_moves'])
        self.assertEqual(result['players'], oracle['players'])
        self.assertEqual(result['player_order'], oracle['player_order'])
        skipped = {**state, 'move_number': state['move_number'] + 2}
        turns.observe(skipped, game.get_log())
        with self.assertRaisesRegex(PublicPositionUnavailable, 'unverified action context'):
            public_rollout(skipped, turns, {}, path, predict, lambda *_: None, perf_counter() + 5,
                           observe=observation)

    def test_round_search_scores_a_different_root_before_deeper_policy_deviations(self):
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'A'}
        match = SimpleNamespace(get_replay=lambda: '')
        direct = {'moves': [{'move': 'Buy', 'policy_gap': 0}, {'move': 'Pass', 'policy_gap': .9}]}
        followups = {'moves': [{'move': 'X', 'policy_gap': 0}, {'move': 'Y', 'policy_gap': .1}]}
        endings = {('Buy',): .3, ('Pass',): .8, ('Buy', 'Y'): .6}
        scored = []
        comparisons = []

        def rollout(_replay, _state, path, _predict, branch, _deadline, *, observe):
            if path == ('Buy',):
                branch(path, ('X', 'Y'), followups)
            return {'rollout_moves': path, 'sampled_draw': False, 'value': endings[path]}

        def score(state, owner):
            self.assertEqual(owner, 'A')
            scored.append(state['value'])
            return state['value'],

        with patch('nations_round_search.rollout_round', side_effect=rollout):
            move, counts, _ = search_round(match, root, ('Buy', 'Pass'), None, direct,
                                           value_score=score, observe=None,
                                           on_override=lambda direct, best: comparisons.append((direct.moves, best.moves)))
        self.assertEqual(scored, [.3, .8, .6])
        self.assertEqual(counts['compared'], 1)
        self.assertEqual(move, 'Pass')
        self.assertEqual(comparisons, [(('Buy',), ('Pass',))])

    def test_round_search_falls_back_if_its_best_line_draws_victoria_falls(self):
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'A', 'round': 8}
        match = SimpleNamespace(get_replay=lambda: '')
        direct = {'moves': [{'move': 'Buy'}, {'move': 'Explore'}]}
        memory = RoundSearchMemory()
        endings = [{'rollout_moves': ('Buy',), 'sampled_draw': False, 'value': .3},
                   {'rollout_moves': ('Explore',), 'sampled_draw': True, 'value': .8}]
        with patch('nations_round_search.rollout_round', side_effect=endings):
            move, counts, _ = search_round(match, root, ('Buy', 'Explore'), None, direct, observe=None,
                                           value_score=lambda state, _: (state['value'],), memory=memory)
        self.assertEqual(counts['compared'], 1)
        self.assertEqual(counts['victoria_falls_fallback'], 1)
        self.assertEqual(move, 'Buy')
        self.assertEqual([line.moves for line in memory.lines], [('Buy',)])

    def test_round_search_reuses_a_matching_rival_reply_and_explores_the_pending_branch(self):
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'A', 'round': 1}
        original = ('Header',)
        match = SimpleNamespace(get_replay=lambda: 'Header\nA buys\nB buys\n')
        direct = {'moves': [{'move': 'Pass'}, {'move': 'Deploy'}]}
        memory = RoundSearchMemory(
            round_number=1, replay=original,
            lines=(RoundLine(('A buys', 'B buys', 'Pass'), 1, (.3,), False),
                   RoundLine(('A buys', 'B buys', 'Deploy'), 3, (.7,), False),
                   RoundLine(('A buys', 'B passes', 'Pass'), 1, (.99,), False)),
            branches=((('A buys', 'B buys', 'Deploy', 'Another'), ((0, .9), (3, .3))),))
        new_line = {'rollout_moves': ('Deploy', 'Another'), 'sampled_draw': False}
        with patch('nations_round_search.rollout_round', return_value=new_line) as engine:
            move, counts, _ = search_round(match, root, ('Pass', 'Deploy'), None, direct, observe=None,
                                           value_score=lambda *_: (.6,), memory=memory)
        engine.assert_called_once()
        self.assertEqual(engine.call_args.args[2], ('Deploy', 'Another'))
        self.assertEqual(counts['reused_settled_lines'], 2)
        self.assertEqual(counts['compared'], 1)
        self.assertEqual(move, 'Deploy')

    def test_round_rollout_captures_completed_resolution_in_the_real_engine(self):
        def predict(state):
            legal = [move for move in state['next_move_options'] if move not in ('UNDO', 'Resign')]
            return {'moves': [{'move': move} for move in sorted(legal, key=lambda m: m not in ('Pass', 'Confirm'))]}

        for target_round in (1, 2, 8):
            with self.subTest(round=target_round):
                match = position_at(lambda m, p: m.round_number == target_round and p == 'Which action?')
                root = match.get_state()
                settled = rollout_round(match.get_replay(), root, ('Pass',), predict, lambda *_: None,
                                        perf_counter() + 5, observe=lambda m: m.get_state())
                self.assertEqual(settled['round'], target_round)
                self.assertTrue(all(p['passed'] for p in settled['players'].values()))
                self.assertEqual(bool(settled['game_over']), target_round == 8)
                self.assertIn('final_winner' if target_round == 8 else 'players', settled)
                if target_round == 2:
                    self.assertEqual(settled['phase'], 'Score Books Phase')

    def test_growth_rollout_resolves_with_forecast_famine_and_architects(self):
        match = position_at(lambda _match, prompt: prompt == 'Take what for growth?')
        root = match.get_state()
        self.assertIsNone(root['event'])
        seen = []

        def predict(state):
            if state['next_move_choice'] == 'Which action?':
                seen.append((state['event'], state['architects'], state['turmoil']))
            return {'moves': [{'move': 'Pass'}]}

        settled = rollout_round(match.get_replay(), root, (root['next_move_options'][0],), predict,
                                lambda *_: None, perf_counter() + 5,
                                observe=lambda branch: {**branch.get_state(), 'log': branch.get_log()},
                                growth_forecast={'famine': 4, 'architects': 2})
        self.assertTrue(seen)
        self.assertEqual(set(seen), {(None, 2, 2)})
        self.assertTrue(all(player['passed'] for player in settled['players'].values()))
        self.assertIn('All players lose 4 [Food].', settled['log'])
        self.assertEqual(match.get_state(), root)

    def test_round_rollout_stops_before_scoring_an_empty_event_menu(self):
        match = position_at(lambda m, p: m.round_number == 1 and p == 'Which action?')

        def predict(state):
            self.assertTrue(state['next_move_options'])
            return {'moves': [{'move': 'Pass'}]}

        def unplaceable_wonder(branch):
            branch.get_move(branch.players[0], 'Place wonder where?', ())

        with patch.object(Match, 'resolution_phase', unplaceable_wonder):
            with self.assertRaisesRegex(SearchBoundary, 'no legal rollout choice'):
                rollout_round(match.get_replay(), match.get_state(), ('Pass',), predict, lambda *_: None,
                              perf_counter() + 5, observe=lambda branch: branch.get_state())

    def test_architect_veto_covers_both_events_and_qin_at_the_final_stage(self):
        player = SimpleNamespace(wonders_under_construction=[SimpleNamespace(completed_stages=1, stage_costs=(2, 3))],
                                 replaceable_wonder_spaces=lambda: 0)
        match = SimpleNamespace(current_player=player)
        for prompt in FREE_ARCHITECT:
            self.assertEqual(safe_architect_options(match, prompt, ('Yes', 'No')), ('No',))
        actions = (QIN_DYNASTY, 'Hire', 'Hire from "Source"', 'Buy P11', 'Pass')
        self.assertEqual(safe_architect_options(match, 'Which action?', actions), ('Buy P11', 'Pass'))
        player.wonders_under_construction[0].completed_stages = 0
        self.assertEqual(safe_architect_options(match, 'Which action?', actions), actions)
        player.wonders_under_construction[0].completed_stages = 1
        player.replaceable_wonder_spaces = lambda: 1
        self.assertEqual(safe_architect_options(match, 'Which action?', actions), actions)
        player.wonders_under_construction[0] = SimpleNamespace(exploration_turns=2)
        self.assertEqual(safe_architect_options(match, 'Which action?', ('Explore',)), ('Explore',))

    def test_round_rollout_declines_a_free_architect_before_the_event_can_get_stuck(self):
        match = position_at(lambda m, p: m.round_number == 1 and p == 'Which action?')
        taken = []

        def free_architect(branch):
            player = branch.players[0]
            player.wonders_under_construction[0] = SimpleNamespace(completed_stages=1, stage_costs=(2, 3))
            player.wonders[:] = [SimpleNamespace(is_natural_wonder_or_extension=lambda: True)] * len(player.wonders)
            taken.append(branch.get_move(player, FREE_ARCHITECT[0], ('Yes', 'No')))

        def predict(state):
            self.assertNotIn('Yes', state['next_move_options'])
            legal = ('Pass', 'Confirm')
            return {'moves': [{'move': move} for move in legal if move in state['next_move_options']]}

        with patch.object(Match, 'resolution_phase', free_architect):
            settled = rollout_round(match.get_replay(), match.get_state(), ('Pass',), predict, lambda *_: None,
                                    perf_counter() + 5, observe=lambda branch: {} if taken else branch.get_state())
        self.assertEqual(taken, ['No'])
        self.assertEqual(settled['rollout_moves'][-1], 'No')

    def test_policy_rollouts_complete_the_direct_line_then_the_best_branch(self):
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'Seat0'}
        match = SimpleNamespace(get_replay=lambda: '')
        spent = {'Seat0': 0, 'Seat1': 0}

        def leaf(value, key):
            return Position({'handoff_next_player': 'Seat1', 'remaining_main_actions': spent, 'value': value},
                            boundary='opponent turn', key=(key,))

        direct = {'moves': [{'move': 'A', 'policy_gap': 0}, {'move': 'B', 'policy_gap': .3}]}
        followed = {
            ('A',): Position({'next_move_choice': 'Which benefit?'}, ('X', 'Y')),
            ('A', 'X'): leaf(.5, 'direct'),
            ('A', 'Y'): Position({'next_move_choice': 'Which action?'}, ('Z', 'T')),
            ('A', 'Y', 'Z'): leaf(.7, 'alternate'),
            ('B',): leaf(.7, 'alternate'),
            ('A', 'Y', 'T'): leaf(.6, 'another'),
        }
        policies = {
            'Which benefit?': {'moves': [{'move': 'X', 'policy_gap': 0}, {'move': 'Y', 'policy_gap': .1}]},
            'Which action?': {'moves': [{'move': 'Z', 'policy_gap': 0}, {'move': 'T', 'policy_gap': .4}]},
        }
        calls = []

        def score(state, owner, next_player, counts, *, starts_turn):
            self.assertEqual(owner, 'Seat0')
            self.assertEqual(next_player, 'Seat1')
            self.assertEqual(counts[owner], 0)
            self.assertTrue(starts_turn)
            calls.append(state['value'])
            return state['value']

        with patch('nations_microsearch.trace', side_effect=lambda _r, _s, path, _d, **_: followed[path]) as engine:
            outcome = search_policy_rollouts(match, root, ('A', 'B'), lambda s: policies[s['next_move_choice']],
                                             direct, value_score=score)
        self.assertEqual([call.args[2] for call in engine.call_args_list], list(followed))
        self.assertEqual(calls, [.5, .7, .6])
        self.assertEqual(outcome['direct_line_value'], .5)
        self.assertEqual(outcome['line_value'], .7)
        self.assertEqual(outcome['line'], ('B',))  # The same handoff was later reached by a shorter route.

    def test_policy_rollouts_keep_only_finished_lines_at_budget_limit(self):
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'Seat0'}
        match = SimpleNamespace(get_replay=lambda: '')
        direct = {'moves': [{'move': 'A'}, {'move': 'B'}]}
        finished = Position({'handoff_next_player': None, 'remaining_main_actions': {'Seat0': 0}},
                            boundary='round resolution')
        unfinished = Position({'next_move_choice': 'Which benefit?'}, ('X', 'Y'))

        with patch('nations_microsearch.trace', side_effect=[finished, unfinished]):
            outcome = search_policy_rollouts(match, root, ('A', 'B'), lambda _: direct, direct,
                                             value_score=lambda *_args, **_kwargs: .5, max_nodes=2)
        self.assertTrue(outcome['budget'])
        self.assertEqual(outcome['line'], ('A',))
        self.assertEqual(outcome['boundaries']['scored handoffs'], 1)

    def test_policy_rollouts_fall_back_when_direct_play_hits_hidden_information(self):
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'Seat0'}
        match = SimpleNamespace(get_replay=lambda: '')
        direct = {'moves': [{'move': 'A'}, {'move': 'B'}]}
        with patch('nations_microsearch.trace', return_value=Position({}, boundary='random outcome')) as engine:
            outcome = search_policy_rollouts(match, root, ('A', 'B'), None, direct, value_score=None)
        engine.assert_called_once()
        self.assertIsNone(outcome['direct_line_value'])
        self.assertEqual(outcome['line'], ())

    def test_search_keeps_public_mixed_rules_at_replayed_prompts(self):
        match = position_at(
            lambda m, prompt: prompt == 'Which action?' and 'Turmoil' in m.next_move_options,
            {'growth_resources': 3, 'weighted_card_draw': True},
        )
        root = match.get_state()
        root['growth_allowances'] = {p.name: p.growth_resources for p in match.players}
        root['weighted_card_draw'] = match.weighted_card_draw
        successor = trace(match.get_replay(), root, ('Turmoil',), perf_counter() + 5, pre_move=True)
        self.assertEqual(successor.state['next_move_choice'], 'Which benefit?')
        for field in ('growth_allowances', 'weighted_card_draw'):
            self.assertEqual(successor.state[field], root[field])

    def test_shorter_route_reuses_the_longer_routes_completed_suffix(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'A'}
        undeploy, buy, slot = 'Undeploy from BM1', 'Buy P12', 'BM1'

        def at(prompt, moves, value, key=None):
            state = {'next_move_choice': prompt, 'next_move_player': 'A', 'value': value, 'moves': moves,
                     'move_number': 10}
            return Position(state, moves, key=key)

        placed = at('Complete the turn?', ('Confirm',), .9, key=('same board',))
        exit_state = {'next_move_player': 'A', 'value': .9, 'moves': ()}
        exit_position = Position(exit_state, boundary='opponent turn', key=('same handoff',))
        branches = {
            (undeploy,): at('Which action?', (buy,), .9),
            (buy,): at('Place card where?', (slot,), .6),
            (undeploy, buy): at('Place card where?', (slot,), .9),
            (undeploy, buy, slot): placed,
            (buy, slot): placed,
            (undeploy, buy, slot, 'Confirm'): exit_position,
            (buy, slot, 'Confirm'): exit_position,
        }

        def predict(state):
            return {'moves': [{'move': move} for move in state['moves']], 'winProbability': state['value']}

        direct = predict({'moves': (undeploy, buy), 'value': .7})
        searches = ((search, {}), (search_pre_move, {}), (search_best_first, {}),
                    (search_broad_best_first, {'score_gap': 1}))
        for read, kwargs in searches:
            with (
                self.subTest(search=read.__name__),
                patch('nations_microsearch.trace', side_effect=lambda _r, _s, path, _d, **_: branches[path]) as engine,
            ):
                result = read(match, root, (undeploy, buy), predict, direct, seconds=5, **kwargs)
                self.assertEqual(result['line'], (buy, slot, 'Confirm'))
                self.assertEqual(result['boundaries']['duplicate positions'], 1)
                paths = [call.args[2] for call in engine.call_args_list]
                self.assertEqual(sum(path[-1] == 'Confirm' for path in paths), 1)
                if read is not search:
                    self.assertLess(paths.index((undeploy, buy, slot)), paths.index((buy, slot)))

    def test_shorter_route_uses_the_correct_resume_move_number(self):
        graph = SearchPositions(None, {'move_number': 10}, ('A', 'B'))
        graph.reach(('A',), Position({'move_number': 12}))
        graph.reach(('A', 'X'), Position({'move_number': 15}, key=('duplicate',)))
        graph.reach(('A', 'X', 'Y'), Position({'move_number': 17}))
        self.assertFalse(graph.reach(('B',), Position({'move_number': 11}, key=('duplicate',)))[1])
        self.assertEqual(graph.plan(('A', 'X', 'Y'), {'move_number': 17}),
                         (('B', 'Y'), {'move_number': 13}))

    def test_search_keeps_one_empty_wonder_placement_and_distinct_replacements(self):
        prediction = {'moves': [{'move': 'W2'}, {'move': 'W1'}], 'move_aliases': {'W3': 'W1', 'W4': 'W1'}}
        for broad in False, True:
            self.assertEqual(ranked_choices('Place wonder where?', ('W1', 'W2', 'W3', 'W4'),
                                            prediction, all_moves=broad), ('W2', 'W1'))

    def test_broad_queue_can_expand_beyond_the_top_two(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?'}
        choices = ('A', 'B', 'C')
        direct = {'moves': [{'move': m} for m in choices], 'winProbability': .6}
        with (
            patch('nations_microsearch.trace', return_value=Position({}, boundary='opponent turn')) as engine,
        ):
            outcome = search_broad_best_first(match, root, choices, self.fail, direct, score_gap=.05)
        self.assertEqual([call.args[2] for call in engine.call_args_list], [('A',), ('B',), ('C',)])
        self.assertFalse(outcome['score_cutoff'])
        self.assertEqual(outcome['line'], ('A',))

    def test_broad_queue_stops_below_the_score_gap(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?'}
        choices = ('A', 'B', 'C')
        direct = {'moves': [{'move': m} for m in choices], 'winProbability': .6}
        reached = Position({'next_move_choice': 'Which benefit?', 'move_number': 4}, ('Exit',))
        forecast = {'moves': [{'move': 'Exit'}], 'winProbability': .8}
        with (
            patch('nations_microsearch.trace',
                  side_effect=[reached, Position({}, boundary='opponent turn')]) as engine,
        ):
            outcome = search_broad_best_first(match, root, choices, lambda _: forecast, direct, score_gap=.05)
        self.assertEqual([call.args[2] for call in engine.call_args_list], [('A',), ('A', 'Exit')])
        self.assertTrue(outcome['score_cutoff'])
        self.assertFalse(outcome['budget'])
        self.assertEqual(outcome['line'], ('A', 'Exit'))

    def test_best_first_expands_the_higher_valued_root_successor(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?'}
        direct = {'moves': [{'move': m} for m in ('A', 'B')], 'winProbability': .5}
        visited = []

        def trace_line(_replay, _root, path, _deadline, *, pre_move):
            self.assertTrue(pre_move)
            visited.append(path)
            if len(path) == 2:
                return Position({}, boundary='opponent turn')
            return Position({'next_move_choice': 'Which action?', 'move_number': 2,
                             'value': .6 if path[0] == 'A' else .9}, ('Exit',))

        def predict(state):
            return {'moves': [{'move': 'Exit'}], 'winProbability': state['value']}

        for limits, cutoff in (({'max_nodes': 3}, 'budget'), ({'score_gap': .05}, 'score_cutoff')):
            with self.subTest(cutoff=cutoff), patch('nations_microsearch.trace', side_effect=trace_line):
                visited.clear()
                outcome = search_best_first(match, root, ('A', 'B'), predict, direct, **limits)
                self.assertEqual(visited, [('A',), ('B',), ('B', 'Exit')])
                self.assertTrue(outcome[cutoff])
                self.assertEqual(outcome['line'], ('B', 'Exit'))
                self.assertIsNone(outcome['resume'])

    def test_best_first_keeps_an_unfinished_high_value_line_at_cutoff(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?'}
        direct = {'moves': [{'move': m} for m in ('A', 'B')], 'winProbability': .5}
        positions = [Position({}, boundary='opponent turn'),
                     Position({'next_move_choice': 'Which benefit?', 'move_number': 4}, ('X', 'Y'))]
        prediction = {'moves': [{'move': 'X'}, {'move': 'Y'}], 'winProbability': .8}
        with (
            patch('nations_microsearch.trace', side_effect=positions),
        ):
            outcome = search_best_first(match, root, ('A', 'B'), lambda _: prediction, direct, max_nodes=2)
        self.assertTrue(outcome['budget'])
        self.assertEqual(outcome['line'], ('B',))
        self.assertEqual(outcome['resume']['move_number'], 4)
        self.assertEqual(outcome['resume']['choices'], ('X', 'Y'))

    def test_handoff_scoring_uses_the_resolved_board_and_original_actor(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'Seat0'}
        direct = {'moves': [{'move': m} for m in ('A', 'B')], 'winProbability': .5}
        positions = [Position({'next_move_player': 'Seat1', 'value': score}, boundary='opponent turn')
                     for score in (.4, .6)]

        def predict(state):
            self.assertEqual(state['next_move_player'], 'Seat0')
            self.assertEqual(state['next_move_choice'], 'Which action?')
            self.assertEqual(state['next_move_options'], ['Pass'])
            return {'winProbability': state['value']}

        with patch('nations_microsearch.trace', side_effect=positions) as engine:
            outcome = search_best_first(match, root, ('A', 'B'), predict, direct, handoff_score=True)
        self.assertTrue(all(call.kwargs['capture_handoff'] for call in engine.call_args_list))
        self.assertEqual(outcome['line'], ('B',))
        self.assertEqual(outcome['line_value'], .6)
        self.assertEqual(outcome['boundaries']['scored handoffs'], 2)

    def test_handoff_scoring_keeps_a_completed_line_at_cutoff(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'Seat0'}
        direct = {'moves': [{'move': m} for m in ('A', 'B')], 'winProbability': .5}
        positions = [Position({}, boundary='opponent turn'),
                     Position({'next_move_choice': 'Which action?', 'move_number': 4}, ('X', 'Y'))]

        def predict(state):
            if state.get('next_move_options') == ['Pass']:
                return {'winProbability': .4}
            return {'moves': [{'move': 'X'}, {'move': 'Y'}], 'winProbability': .8}

        with patch('nations_microsearch.trace', side_effect=positions):
            outcome = search_best_first(match, root, ('A', 'B'), predict, direct,
                                        max_nodes=2, handoff_score=True)
        self.assertTrue(outcome['budget'])
        self.assertTrue(outcome['selected_scored_handoff'])
        self.assertEqual(outcome['line'], ('A',))

    def test_retrained_head_sees_available_actions_and_handoff_context(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?', 'next_move_player': 'Seat0'}
        direct = {'moves': [{'move': m} for m in ('A', 'B')], 'winProbability': .5}
        available = {'Seat0': 1, 'Seat1': 0}
        spent = {'Seat0': 0, 'Seat1': 0}
        after_undeploy = Position({'next_move_choice': 'Which action?', 'move_number': 4}, ('X', 'Y'),
                                  remaining_main_actions=available)
        after_purchase = Position({'handoff_next_player': 'Seat1', 'remaining_main_actions': spent},
                                  boundary='opponent turn')
        before_resolution = Position({'handoff_next_player': None, 'remaining_main_actions': spent},
                                     boundary='round resolution')
        observed = []

        def score(_state, owner, next_player, actions, *, starts_turn=False):
            observed.append((owner, next_player, actions[owner], starts_turn))
            return .7 if next_player is None else .6

        def predict(_state):
            return {'moves': [{'move': 'Y'}, {'move': 'X'}], 'winProbability': .99}

        with patch('nations_microsearch.trace',
                   side_effect=[after_undeploy, after_purchase, before_resolution, after_purchase]) as engine:
            result = search_best_first(match, root, ('A', 'B'), predict, direct,
                                       handoff_score=True, value_score=score)
        self.assertEqual([call.args[2] for call in engine.call_args_list], [('A',), ('B',), ('A', 'Y'), ('A', 'X')])
        self.assertEqual(observed, [('Seat0', 'Seat0', 1, False), ('Seat0', 'Seat1', 0, True),
                                    ('Seat0', None, 0, False), ('Seat0', 'Seat1', 0, True)])
        self.assertEqual(result['line'], ('A', 'Y'))
        self.assertEqual(result['line_value'], .7)

    def test_cutoff_uses_a_scored_frontier_over_an_unscored_confirmation(self):
        match = SimpleNamespace(get_replay=lambda: '', current_player=None)
        root = {'next_move_choice': 'Which action?'}
        choices = ('Deploy', 'Buy')
        direct = {'moves': [{'move': move} for move in choices], 'winProbability': .9}
        confirmation = Position({'next_move_choice': 'Complete the turn?', 'move_number': 2},
                                ('Confirm', 'Undeploy'))
        action = Position({'next_move_choice': 'Which action?', 'move_number': 3}, ('Pass',))

        def predict(state):
            if state['next_move_choice'] == 'Complete the turn?':
                return {'moves': [{'move': 'Confirm'}], 'winProbability': None}
            return {'moves': [{'move': 'Pass'}], 'winProbability': .7}

        for search, limits in ((search_best_first, {}), (search_broad_best_first, {'score_gap': .05})):
            with (
                self.subTest(search=search.__name__),
                patch('nations_microsearch.trace', side_effect=[confirmation, action]),
            ):
                outcome = search(match, root, choices, predict, direct, max_nodes=2, **limits)
                self.assertTrue(outcome['budget'])
                self.assertEqual(outcome['line'], ('Buy',))
                self.assertEqual(outcome['resume']['prompt'], 'Which action?')

    def test_pre_move_search_stops_before_round_resolution_and_opponent_turn(self):
        fixtures = Path(__file__).resolve().parents[1] / 'live-player/fixtures'

        def stop(*_):
            raise PublicDecisionFixture()

        for name, boundary in (('hidden-draw', 'round resolution'), ('opponent-turn', 'opponent turn')):
            with self.subTest(name=name):
                replay = (fixtures / f'lookahead-pass-before-{name}.replay').read_text(encoding='utf-8')
                match = Match(replay=replay, move_getter=stop)
                with self.assertRaises(PublicDecisionFixture):
                    match.play()
                root = match.get_state()
                position = trace(match.get_replay(), root, ('Pass',), perf_counter() + 5, pre_move=True)
                self.assertEqual(position.boundary, boundary)
                self.assertEqual(position.state, {})
                captured = trace(match.get_replay(), root, ('Pass',), perf_counter() + 5,
                                 pre_move=True, capture_handoff=True)
                self.assertEqual(captured.boundary, boundary)
                self.assertEqual(captured.state['round'], root['round'])
                self.assertEqual(captured.state['phase'], 'Action Phase')
                self.assertTrue(captured.state['players'][root['next_move_player']]['passed'])
                self.assertEqual(match.get_state(), root)

    def test_pre_move_search_uses_policy_order_for_two_immediate_handoffs(self):
        match = position_at(lambda m, prompt: prompt == 'Which action?')
        root = match.get_state()
        purchase = next(option for option in match.current_player.buy_actions()
                        if trace(match.get_replay(), root, (str(option),), perf_counter() + 5,
                                 pre_move=True).boundary == 'opponent turn')
        options = [purchase, PassAction()]

        def predict(_):
            self.fail('An immediate handoff should use the pre-move prediction')

        for first, second in ((str(purchase), 'Pass'), ('Pass', str(purchase))):
            direct = {'moves': [{'move': first}, {'move': second}], 'winProbability': .8}
            result = search_pre_move(match, root, options, predict, direct, seconds=5)
            self.assertEqual(result['line'], (first,))
            self.assertEqual(result['nodes'], 2)

    def test_undeploy_cannot_displace_pass_at_an_unscored_or_different_endpoint(self):
        fixtures = Path(__file__).resolve().parents[1] / 'live-player/fixtures'

        def stop(*_):
            raise PublicDecisionFixture()

        def evaluate(state):
            ranked = sorted(state['next_move_options'], key=lambda move:
                            0 if move == 'Pass' else 1 if move.startswith('Undeploy') else 2)
            trained = state['next_move_choice'] in ('Which action?', 'Which benefit?', 'Play which dynasty?')
            return {'moves': [{'move': move} for move in ranked], 'winProbability': .8 if trained else None}

        for name, expected in (('hidden-draw', None), ('opponent-turn', .2)):
            with self.subTest(name=name):
                replay = (fixtures / f'lookahead-pass-before-{name}.replay').read_text(encoding='utf-8')
                match = Match(replay=replay, move_getter=stop)
                with self.assertRaises(PublicDecisionFixture):
                    match.play()
                result = explore(match, evaluate, depth=1, seconds=5)
                passed = next(row for row in result['moves'] if row['move'] == 'Pass')
                if expected is None:
                    self.assertIsNone(passed['winProbability'])
                else:
                    self.assertAlmostEqual(passed['winProbability'], expected)
                self.assertEqual(result.get('recommendedMove', result['moves'][0]['move']), 'Pass')

    def after_pass(self, round_number):
        match = position_at(lambda m, prompt: m.round_number == round_number and prompt == 'Which action?'
                            and any(p.passed for p in m.players))
        path = ('Pass',)
        # Some revealed events require a public decision before round end.
        for _ in range(10):
            result = branch(match.get_replay(), match.get_state(), path, perf_counter() + 5)
            if result.stop:
                return result.winner, result.stop
            self.assertEqual(result.position['round'], round_number)
            path += (next(option for option in result.position['next_move_options'] if option not in ('UNDO', 'Resign')),)
        self.fail('Round resolution did not reach a boundary')

    def test_uses_engine_successor_and_converts_rival_value_to_root_perspective(self):
        match = position_at(lambda m, prompt: m.round_number == 1 and prompt == 'Which action?')
        root = match.get_state()
        seen = []

        def evaluate(state):
            seen.append(state)
            ordered = sorted(state['next_move_options'], key=lambda move: move != 'Pass')
            return {'moves': [{'move': move} for move in ordered], 'winProbability': .8}

        result = explore(match, evaluate, depth=1, candidates=1, seconds=5)
        self.assertEqual(result['moves'][0]['move'], 'Pass')
        self.assertAlmostEqual(result['moves'][0]['winProbability'], .2)
        self.assertNotEqual(seen[1]['next_move_player'], root['next_move_player'])
        self.assertTrue(seen[1]['players'][root['next_move_player']]['passed'])
        self.assertEqual(match.get_state(), root)

    def test_draft_branches_have_a_comparison_before_turn_counters_are_initialized(self):
        match = position_at(lambda m, prompt: prompt == 'Draft which nation?')
        owner = match.next_move_player
        offered = list(match.next_move_options)
        alternative = offered[1]

        def evaluate(state):
            # This player's draft is followed by the rival's draft. An estimate
            # of .25 for that rival puts the alternative ahead for the owner.
            value = .25 if state['players'][owner]['nation'] == alternative else .5
            return {'moves': [], 'winProbability': value}

        result = explore(match, evaluate, depth=1, seconds=5)
        self.assertGreaterEqual(sum(row['comparable'] for row in result['moves']), 2)
        self.assertEqual(result['policyMove'], offered[0])
        self.assertEqual(result['recommendedMove'], alternative)

    def test_stops_before_hidden_event_at_growth_and_before_next_market(self):
        growth = position_at(lambda m, prompt: m.round_number == 1 and prompt == 'Take what for growth?'
                             and m.next_move_player == m.players[0].name)
        result = branch(growth.get_replay(), growth.get_state(), ('2 [Gold]',), perf_counter() + 5)
        self.assertEqual(result, Transition(stop='unrevealed event'))
        self.assertEqual(self.after_pass(1), (None, 'unrevealed progress cards'))

    def test_can_score_a_game_that_ends_without_another_draw(self):
        winner, reason = self.after_pass(8)
        self.assertIn(winner, ('A', 'B'))
        self.assertEqual(reason, 'final scoring')

    def test_engine_in_round_card_draw_and_random_methods_are_blocked(self):
        match = position_at(lambda m, prompt: prompt == 'Which action?')
        lock_hidden_information(match)
        with self.assertRaisesRegex(SearchBoundary, 'unrevealed progress cards'):
            match.draw_cards(20)
        with self.assertRaisesRegex(SearchBoundary, 'random outcome'):
            match.random.choice(['visible', 'hidden'])

    def test_does_not_return_a_partial_candidate_comparison_when_budget_ends(self):
        match = position_at(lambda m, prompt: prompt == 'Which action?')
        result = explore(match, lambda state: {'moves': [], 'winProbability': .5},
                         max_nodes=1, candidates=2, seconds=5)
        self.assertTrue(result['budgetReached'])
        self.assertEqual(result['completedDepth'], 0)
        self.assertEqual(result['moves'], [])


if __name__ == '__main__':
    unittest.main()
