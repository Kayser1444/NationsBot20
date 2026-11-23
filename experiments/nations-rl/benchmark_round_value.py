"""Compare policy checkpoints, round scorers, or search at the growth choice."""
import argparse
from collections import Counter
from pathlib import Path
from random import Random
from statistics import mean
import sys
from time import perf_counter

from compare_position_checkpoints import read, run_wave
from compare_position_encoding import StaticFallback, load_structured, position_encoder
from compare_position_microsearch import RoundPlayer
from mixed_rules import RULE_MIX, rules_for_board
from train import ROOT, board_seed, digest, emit, play_game, seed_all, summarize, write_json
from train_round_value import load_round_value


BOARD_NAMESPACE = 'paired-round-scorers-v1'


def worker(manifest_path, jobs_path):
    setup = read(manifest_path)
    output, batch = manifest_path.parent, Path(setup['batch'])
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from nations_round_search import search_round

    growth_forecasts = setup.get('growth_forecasts')
    if growth_forecasts:
        from growth_search import GROWTH, search_growth

    if setup.get('public_snapshot'):
        from nations_public_round import PublicTurns, public_rollout
        from nations_microsearch import MAIN
        from train_round_value import round_observation

        class ObservedMatch(Match):
            def __init__(self, *args, move_getter, **kwargs):
                self.public_turns = PublicTurns()

                def observe(prompt, options, undo):
                    self.public_turns.observe(self.get_state(), self.get_log())
                    return move_getter(prompt, options, undo)

                super().__init__(*args, move_getter=observe, **kwargs)
    else:
        ObservedMatch = Match

    seed_all(setup['seed'], 1)
    policy = setup['challenger']
    model = load_structured(Path(policy['path']), policy['encoding']).requires_grad_(False)
    models = dict.fromkeys(setup['arms'], model)
    for arm, entry in setup.get('policies', {}).items():
        if entry['encoding'] != policy['encoding'] or digest(Path(entry['path'])) != entry['sha256']:
            raise ValueError('Alternate policy encoding or checkpoint changed')
        models[arm] = load_structured(Path(entry['path']), entry['encoding']).requires_grad_(False)
    encoder = position_encoder(batch, policy['encoding'])
    scorers = {name: None if not entry else load_round_value(batch, entry) for name, entry in setup['arms'].items()}
    fallback = StaticFallback(batch)
    try:
        for index in read(jobs_path):
            seed = setup['board_seeds'][index]
            rules = rules_for_board(setup['seed'], index)
            games = []
            for seat in range(2):
                assignment = {f'Seat{seat}': 'left', f'Seat{1-seat}': 'right'}
                players = {owner: RoundPlayer(models[arm], encoder, fallback, owner, search_round, setup['search'],
                                              value_score=scorers[arm], policy_rollouts=True)
                           for owner, arm in assignment.items() if scorers[arm] is not None}

                def choose(match, state, options):
                    owner = state['next_move_player']
                    player = players.get(owner)
                    if growth_forecasts and assignment[owner] == 'left' and state['next_move_choice'] == GROWTH:
                        forecast = growth_forecasts[(state['round'] - 1) // 2]
                        move, counts, seconds = search_growth(
                            match, state, options, player.predict, forecast=forecast, value_score=player.value_score,
                            observe=round_observation, seconds=setup['search']['hard_seconds'])
                        player.counts.update(counts)
                        player.counts['growth time ms'] += round(seconds * 1000)
                        if move is not None:
                            player.counts[f'growth changed round {state["round"]}'] += 1
                        return move
                    if player is not None and setup.get('public_snapshot'):
                        if state['next_move_choice'] != MAIN or state['phase'] != 'Action Phase':
                            return None
                        state = state | {'resource_tiebreak': rules.get('resource_remainder_tiebreaker', False)}

                        def rollout(_replay, public, prefix, predict, branch, deadline, *, observe):
                            return public_rollout(public, match.public_turns, rules, prefix, predict, branch, deadline,
                                                  observe=observe)

                        # Never pass the seeded replay into the snapshot implementation.
                        from types import SimpleNamespace
                        public = SimpleNamespace(get_replay=lambda: '')
                        move, counts, duration = search_round(public, state, options, player.predict,
                                                              player.predict(state), value_score=player.value_score,
                                                              observe=round_observation, rollout=rollout, **setup['search'])
                        player.counts.update(counts)
                        player.timings.append(duration)
                        if counts['compared']:
                            return move
                        player.counts['direct fallback'] += 1
                        return None
                    return player.choose(match, state, options) if player is not None else None

                replay = output / 'replays' / f'{index:04}-{seat}.replay'
                row, _ = play_game(ObservedMatch, encoder, fallback, {owner: models[arm] for owner, arm in assignment.items()}, (), seed, replay,
                                   sample=False, sampling_seed=0, seconds=300, rules=rules, move_override=choose)
                row.update(candidate=f'Seat{seat}', opponent=f'Seat{1-seat}',
                           search_counts={assignment[owner]: dict(player.counts) for owner, player in players.items()})
                games.append(row)
            write_json(output / 'boards' / f'{index:04}.json', {'index': index, 'seed': seed, 'games': games})
    finally:
        fallback.close()


def report(output, setup):
    boards = [read(output / 'boards' / f'{index:04}.json') for index in range(len(setup['board_seeds']))]
    errors, differences, games = [], [], []
    counts = {arm: Counter() for arm in setup['arms']}
    for index, board in enumerate(boards):
        if board['seed'] != setup['board_seeds'][index] or {g['candidate'] for g in board['games']} != {'Seat0', 'Seat1'}:
            raise ValueError('Benchmark board or seats differ from the schedule')
        expected_rules = rules_for_board(setup['seed'], index)
        if any(g['rules'] != expected_rules or not (output / 'replays' / g['replay']).is_file() for g in board['games']):
            raise ValueError('Missing replay or incorrect mixed settings')
        bad = [{'board': index, 'seat': g['candidate'], 'error': g['error']} for g in board['games'] if g['error']]
        if bad:
            errors.extend(bad)
            continue
        games.extend(board['games'])
        differences.append(tuple(mean(values) for values in zip(*[
            (g['rewards'][g['candidate']], g['scores'][g['candidate']] - g['scores'][g['opponent']])
            for g in board['games']])))
        for game in board['games']:
            for arm, stats in game['search_counts'].items():
                counts[arm].update(stats)
    result = {'boards': len(boards), 'complete_boards': len(differences), 'arms': setup['arms'],
              'left': summarize(games), 'right': summarize([g | {'candidate': g['opponent'], 'opponent': g['candidate']}
                                                          for g in games]),
              'errors': errors, 'search_counts': {arm: dict(value) for arm, value in counts.items()}}
    if differences:
        rng = Random(197)
        draws = [rng.choices(differences, k=len(differences)) for _ in range(4000)]
        for dimension, name in enumerate(('left_win_rate', 'left_vp_margin')):
            samples = sorted(mean(d[dimension] for d in sample) for sample in draws)
            result[f'{name}_95'] = [samples[100], samples[3899]]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--training', type=Path, required=True)
    parser.add_argument('--left', required=True, help='Round scorer checkpoint or "direct".')
    parser.add_argument('--right', required=True, help='Round scorer checkpoint or "direct".')
    parser.add_argument('--left-policy', type=Path, help='Different policy checkpoint for the left arm.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seed', type=int, required=True)
    parser.add_argument('--boards', type=int, default=24)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--public-snapshot', action='store_true',
                        help='Rebuild search roots from public snapshots and logs.')
    parser.add_argument('--growth-search', action='store_true',
                        help='Search all growth choices for the left arm using age-average famine and median architects.')
    args = parser.parse_args()
    if min(args.boards, args.workers) < 1:
        parser.error('Use positive board and worker counts')
    if args.growth_search:
        if not args.public_snapshot or args.left == 'direct' or args.left != args.right or args.left_policy:
            parser.error('Growth search requires the same round scorer and policy in both public-snapshot arms')
    elif args.left == args.right and args.left_policy is None:
        parser.error('Use positive counts and two different arms')
    training = read(args.training / 'manifest.json')
    setup = {key: training[key] for key in ('batch', 'challenger', 'rule_mix', 'search')}
    if setup['rule_mix'] != RULE_MIX or digest(Path(setup['challenger']['path'])) != setup['challenger']['sha256']:
        raise ValueError('Frozen policy checkpoint or rule mix changed')
    setup['arms'] = {}
    for arm, raw in (('left', args.left), ('right', args.right)):
        path = Path(raw).resolve() if raw != 'direct' else None
        setup['arms'][arm] = {'path': str(path), 'sha256': digest(path)} if path else None
    if args.left_policy is not None:
        candidate = args.left_policy.resolve()
        setup['policies'] = {'left': {'path': str(candidate), 'sha256': digest(candidate),
                                     'encoding': setup['challenger']['encoding']}}
    seeds = [board_seed(BOARD_NAMESPACE, args.seed, index) for index in range(args.boards)]
    if set(seeds) & set(training['board_seeds']):
        raise ValueError('Training and benchmark boards overlap')
    setup.update(seed=args.seed, board_seeds=seeds)
    if args.public_snapshot:
        setup['public_snapshot'] = True
    if args.growth_search:
        sys.path[:0] = [str(Path(setup['batch']) / 'snapshot/engine'), str(ROOT / 'scripts')]
        from growth_search import forecasts_by_age
        setup['growth_forecasts'] = forecasts_by_age()
    output = args.output.resolve()
    manifest = output / 'manifest.json'
    if args.resume:
        if read(manifest) != setup or (output / 'results.json').exists():
            raise ValueError('Resume requires an unfinished run with the same inputs')
    else:
        for subdir in ('boards', 'replays'):
            (output / subdir).mkdir(parents=True)
        write_json(manifest, setup)
    start = perf_counter()
    pending = [i for i in range(len(seeds)) if not (output / 'boards' / f'{i:04}.json').is_file()]
    emit({'stage': 'head-to-head', 'scheduled_boards': len(pending), 'games': 2 * len(pending)})
    if pending:
        wave = len(list(output.glob('wave-*-worker-00.json')))
        run_wave(manifest, pending, args.workers, wave, worker_script=__file__)
    result = report(output, setup)
    result['seconds'] = round(perf_counter() - start, 2)
    write_json(output / 'results.json', result)
    emit(result)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
