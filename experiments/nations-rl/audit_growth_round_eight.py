"""Replay both growth choices from each archived final-round override."""
import argparse
from collections import deque
from pathlib import Path
from statistics import mean
import sys
from time import perf_counter
from types import SimpleNamespace

from audit_policy_reading import committed_prompts
from compare_position_checkpoints import read
from compare_position_encoding import StaticFallback, load_structured, position_encoder
from compare_position_microsearch import RoundPlayer
from train import ROOT, digest, seed_all, write_json
from train_round_value import load_round_value, round_observation


def finish_actual(match_type, prefix, root, growth, player, rules, settings=None):
    from nations_microsearch import ADMIN, MAIN, ranked_choices
    from nations_move_safety import safe_architect_options, with_move_options
    from nations_public_round import PublicTurns, public_rollout
    from nations_round_search import search_round

    owner = root['next_move_player']
    turns = PublicTurns() if settings is not None else None
    event_details = None
    start = root['move_number']
    deadline = perf_counter() + 35

    def choose(prompt, options, _undo):
        nonlocal event_details
        if match.invalid_move or match.move_number - start > 1000 or perf_counter() >= deadline:
            raise ValueError('Actual continuation hit an invalid move or decision limit')
        state = round_observation(match)
        if turns is not None:
            turns.observe(state, match.get_log())
        legal = {str(option): option for option in safe_architect_options(match, prompt, options)
                 if str(option) not in ADMIN}
        if recorded:
            return legal[recorded.popleft()]
        if state['move_number'] == start:
            if state != root:
                raise ValueError('Actual continuation did not reproduce the growth prompt')
            return legal[growth]
        if event_details is None and match.event is not None:
            event_details = {'id': match.event.abbr, 'name': match.event.name,
                             'famine': -match.event.famine, 'architects': match.architects}
        if len(legal) == 1:
            return next(iter(legal.values()))
        state = with_move_options(state, legal)
        prediction = player.predict(state)
        if turns is not None and prompt == MAIN and state['phase'] == 'Action Phase':
            def rollout(_replay, public, path, predict, branch, deadline, *, observe):
                return public_rollout(public, turns, rules, path, predict, branch, deadline, observe=observe)

            move, counts, _ = search_round(SimpleNamespace(get_replay=lambda: ''), state, legal, player.predict,
                                           prediction, value_score=player.value_score, observe=round_observation,
                                           rollout=rollout, **settings)
            if counts['compared']:
                return legal[move]
        return legal[ranked_choices(prompt, legal, prediction, all_moves=True)[0]]

    match = match_type(replay=prefix, move_getter=choose)
    recorded = deque(match.move_list)
    match.move_list.clear()
    match.play()
    if recorded or not match.game_over or match.round_number != 8:
        raise ValueError('Actual continuation did not reach final scoring')
    scores = {p.name: p.score() for p in match.players}
    rival = next(p.name for p in match.players if p.name != owner)
    remainders = {p.name: p.resource_remainder() for p in match.players}
    winner = min(match.players, key=lambda p: (-scores[p.name], -remainders[p.name]
                 if match.resource_remainder_tiebreaker else 0)).name
    return {'won': winner == owner, 'margin': scores[owner] - scores[rival], 'scores': scores,
            'tiebreak': remainders[owner] - remainders[rival] if match.resource_remainder_tiebreaker else 0,
            'event': event_details}


def score_key(result):
    return result['won'], result['margin'], result['tiebreak']


def comparison(rows, name):
    pairs = [row[name] for row in rows]
    rankings = [(score_key(pair['searched']), score_key(pair['direct'])) for pair in pairs]
    return {'searched_wins': sum(pair['searched']['won'] for pair in pairs),
            'direct_wins': sum(pair['direct']['won'] for pair in pairs),
            'win_flips_toward_search': sum(pair['searched']['won'] and not pair['direct']['won'] for pair in pairs),
            'win_flips_toward_direct': sum(pair['direct']['won'] and not pair['searched']['won'] for pair in pairs),
            'searched_better': sum(searched > direct for searched, direct in rankings),
            'direct_better': sum(searched < direct for searched, direct in rankings),
            'equal': sum(searched == direct for searched, direct in rankings),
            'margin_difference': mean(pair['searched']['margin'] - pair['direct']['margin'] for pair in pairs)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('benchmark', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    setup = read(args.benchmark / 'manifest.json')
    batch = Path(setup['batch'])
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from growth_search import GROWTH
    from nations_microsearch import ADMIN, ranked_choices
    from nations_round_search import rollout_round

    policy = setup['challenger']
    path = Path(policy['path'])
    if setup['arms']['left'] != setup['arms']['right'] or setup.get('policies') or digest(path) != policy['sha256']:
        raise ValueError('Audit requires the same frozen policy and scorer on both sides')
    seed_all(setup['seed'], 1)
    model = load_structured(path, policy['encoding']).requires_grad_(False)
    encoder = position_encoder(batch, policy['encoding'])
    score = load_round_value(batch, setup['arms']['left'])
    fallback = StaticFallback(batch)
    rows = []
    try:
        for board_path in sorted((args.benchmark / 'boards').glob('*.json')):
            for game in read(board_path)['games']:
                if not game['search_counts']['left'].get('growth changed round 8'):
                    continue
                archive = (args.benchmark / 'replays' / game['replay']).read_text(encoding='utf-8')
                prompts, scores = committed_prompts(Match, archive, round_observation)
                if scores != game['scores']:
                    raise ValueError('Archived scores did not reproduce')
                owner = game['candidate']
                [(root, prefix, searched)] = [(state, history, move) for state, history, move in prompts
                                               if state['round'] == 8 and state['next_move_player'] == owner
                                               and state['next_move_choice'] == GROWTH]
                player = RoundPlayer(model, encoder, fallback, owner, None, setup['search'],
                                     value_score=score, policy_rollouts=True)
                legal = tuple(move for move in root['next_move_options'] if move not in ADMIN)
                choices = ranked_choices(GROWTH, legal, player.predict(root), all_moves=True)
                direct = choices[0]
                if direct == searched:
                    raise ValueError('Recorded growth override equals the policy choice')
                forecast, actual_policy, actual_search = {}, {}, {}
                for label, move in (('direct', direct), ('searched', searched)):
                    settled = rollout_round(prefix, root, (move,), player.predict, lambda *_: None,
                                            perf_counter() + 10, observe=round_observation,
                                            growth_forecast=setup['growth_forecasts'][3])
                    if settled['sampled_draw']:
                        raise ValueError('A recorded override sampled a Victoria Falls draw')
                    won, margin, tiebreak = score(settled, owner)
                    forecast[label] = {'won': won, 'margin': margin, 'tiebreak': tiebreak}
                    actual_policy[label] = finish_actual(Match, prefix, root, move, player, game['rules'])
                    actual_search[label] = finish_actual(Match, prefix, root, move, player, game['rules'],
                                                         settings=setup['search'])
                if score_key(forecast['searched']) <= score_key(forecast['direct']):
                    raise ValueError('Growth override did not improve the neutral forecast')
                archived_win = game['rewards'][owner] == 1.0
                rows.append({'replay': game['replay'], 'player': owner, 'direct': direct, 'searched': searched,
                             'forecast': forecast, 'actual_policy': actual_policy, 'actual_search': actual_search,
                             'archived_won': archived_win, 'archived_scores': scores,
                             'archived_search_reproduced': actual_search['searched']['scores'] == scores
                             and actual_search['searched']['won'] == archived_win})
    finally:
        fallback.close()

    expected = read(args.benchmark / 'results.json')['search_counts']['left']['growth changed round 8']
    if len(rows) != expected:
        raise ValueError(f'Audited {len(rows)} overrides. Expected {expected}.')
    totals = {name: comparison(rows, name) for name in ('forecast', 'actual_policy', 'actual_search')}
    totals.update(overrides=len(rows), archived_wins=sum(row['archived_won'] for row in rows),
                  archived_search_reproduced=sum(row['archived_search_reproduced'] for row in rows))
    write_json(args.output, {'summary': totals, 'cases': rows})
    print(totals)


if __name__ == '__main__':
    main()
