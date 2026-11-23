"""Play deterministic lookahead against its own checkpoint on paired fresh boards."""
import argparse
import atexit
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from hashlib import sha256
import json
from pathlib import Path
from random import Random
from statistics import mean, median
import sys
from time import perf_counter

from nations_lookahead import explore
from nations_move_safety import safe_architect_options, with_move_options
from nations_policy import SharedScorer


def initialize(engine, checkpoint):
    global Match, scorer
    sys.path.insert(0, str(engine))
    from nations import Match
    scorer = SharedScorer()
    atexit.register(scorer.close)
    scorer.request({'loadExperimentalCheckpoint': str(checkpoint)})


def seed_for(seed, board):
    return sha256(f'nations-lookahead-paired-v1/{seed}/{board}'.encode()).hexdigest()


def run_game(seed, seat, rules, output, mode='turns'):
    names = ['Seat0', 'Seat1']
    reader, rival = names[seat], names[1 - seat]
    features = Counter()
    search_times = []
    started = perf_counter()
    calls = 0
    plan = ()

    def predict(state):
        return scorer.request({'state': state, 'experimentalAnalysis': True})

    def choose(prompt, options, _undo):
        nonlocal calls, plan
        calls += 1
        if calls > 1800 or perf_counter() - started > 300:
            raise RuntimeError('Game budget exceeded')
        if match.invalid_move:
            raise RuntimeError('The game engine rejected the previous move')
        options = safe_architect_options(match, prompt, options)
        legal = {str(option): option for option in options if str(option) not in ('UNDO', 'Resign')}
        if len(legal) == 1:
            return next(iter(legal.values()))
        state = with_move_options(match.get_state(), options)
        if plan:
            if state['next_move_player'] == reader and plan[0] in legal:
                move, *remaining = plan
                plan = tuple(remaining)
                features['planned_followups'] += 1
                return legal[move]
            plan = ()
            features['plan_interrupted'] += 1
        prediction = predict(state)
        choice = next(row['move'] for row in prediction['moves'] if row['move'] in legal)
        if (mode == 'micro' and state['next_move_player'] == reader
                and state['next_move_choice'] == 'Which action?' and str(match.phase) == 'Action Phase'):
            from nations_microsearch import search
            features['searched'] += 1
            analysis = search(match, state, options, predict, prediction)
            search_times.append(analysis['duration_ms'])
            features['budget_reached'] += analysis['budget']
            features['nodes'] += analysis['nodes']
            for boundary, count in analysis['boundaries'].items():
                features[f'frontier: {boundary}'] += count
            if analysis['line']:
                features['compared'] += 1
                features['changed_move'] += analysis['line'][0] != choice
                choice, *remaining = analysis['line']
                plan = tuple(remaining)
        elif mode == 'turns' and state['next_move_player'] == reader and prediction['winProbability'] is not None:
            features['searched'] += 1

            def evaluate(position):
                if position['move_number'] == state['move_number']:
                    return prediction
                return predict(position)

            analysis = explore(match, evaluate, recommendation_only=True)
            search_times.append(analysis.get('durationMs', 0))
            features['budget_reached'] += int(analysis.get('budgetReached', False))
            compared = [row for row in analysis.get('moves', []) if row['comparable']]
            if compared:
                features['compared'] += 1
                recommended = analysis['recommendedMove']
                features['changed_move'] += int(choice != recommended)
                features['pass_to_undeploy'] += int(choice == 'Pass' and recommended.startswith('Undeploy '))
                choice = recommended
                selected = next(row for row in compared if row['move'] == choice)
                features[f'chosen_line_{len(selected["line"])}_decisions'] += 1
        return legal[choice]

    match = Match(player_names=names, seed=seed, move_getter=choose, rules=rules)
    row = {'seed': seed, 'seat': seat, 'failure': None}
    try:
        match.play()
        if not match.game_over or match.phase.name != 'SCORING' or match.round_number != 8:
            raise RuntimeError('Game did not reach final scoring')
        scores = {player.name: player.score() for player in match.players}
        winner = min(match.players, key=lambda player: (-scores[player.name],
                     -player.resource_remainder() if match.resource_remainder_tiebreaker else 0))
        row.update(win=winner.name == reader, score=scores[reader], opponent_score=scores[rival])
    except Exception as error:
        row.update(win=False, failure=f'{type(error).__name__}: {error}',
                   failed_actor=match.next_move_player, failed_prompt=match.next_move_choice)
    (output / 'replays' / f'{seed[:16]}-{seat}.replay').write_text(match.get_replay(), encoding='utf-8')
    return row | {'counts': dict(features), 'search_ms': search_times,
                  'wall_seconds': round(perf_counter() - started, 2)}


def summarize(rows):
    completed = [row for row in rows if not row['failure']]
    failures = Counter(row['failure'] for row in rows if row['failure'])
    by_board = {}
    counts = Counter()
    for row in completed:
        by_board.setdefault(row['seed'], []).append(row['win'])
        counts.update(row['counts'])
    pairs = [mean(games) for games in by_board.values() if len(games) == 2]
    interval = None
    if len(pairs) > 1:
        rng = Random(7384)
        samples = sorted(mean(rng.choices(pairs, k=len(pairs))) for _ in range(4000))
        interval = [samples[100], samples[3899]]
    timings = sorted(t for row in completed for t in row['search_ms'])
    paired_games = [row for row in completed if len(by_board[row['seed']]) == 2]
    return {'attempted': len(rows), 'completed': len(completed), 'complete_board_pairs': len(pairs),
            'lookahead_wins': sum(row['win'] for row in completed),
            'paired_win_rate': mean(pairs) if pairs else None, 'paired_bootstrap_95': interval,
            'mean_vp_margin': mean(row['score'] - row['opponent_score'] for row in paired_games) if paired_games else None,
            'failures': dict(failures), 'search_counts': dict(counts),
            'search_p50_ms': median(timings) if timings else None,
            'search_p95_ms': timings[int(.95 * (len(timings) - 1))] if timings else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--batch', type=Path, required=True, help='Training batch with its frozen rules engine.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--boards', type=int, default=48)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--seed', type=int, default=161161)
    parser.add_argument('--mode', choices=('turns', 'micro'), default='turns')
    parser.add_argument('--shards', type=int, default=1)
    parser.add_argument('--shard', type=int, default=0)
    args = parser.parse_args()
    if min(args.boards, args.workers, args.shards) < 1 or not 0 <= args.shard < args.shards:
        parser.error('Choose positive board and worker counts')
    checkpoint, batch, output = args.checkpoint.resolve(), args.batch.resolve(), args.output.resolve()
    manifest = json.loads((batch / 'manifest.json').read_text(encoding='utf-8'))
    engine = batch / 'snapshot/engine'
    (output / 'replays').mkdir(parents=True, exist_ok=False)
    seeds = [seed_for(args.seed, board) for board in range(args.shard, args.boards, args.shards)]
    used = {json.loads(line)['seed'] for line in (batch / 'training.jsonl').read_text(encoding='utf-8').splitlines()}
    for path in (batch / 'evaluations').glob('*.json'):
        used.update(row['seed'] for row in json.loads(path.read_text(encoding='utf-8'))['games'])
    known = set(manifest['human_seed_hashes'])
    if used.intersection(seeds) or any(sha256(bytes.fromhex(seed)).hexdigest() in known for seed in seeds):
        raise ValueError('Benchmark seeds overlap prior games')
    metadata = {'checkpoint_sha256': sha256(checkpoint.read_bytes()).hexdigest(), 'rules': manifest['rules'],
                'boards': args.boards, 'seed': args.seed, 'search': {'depth': 3, 'candidates': 4, 'reply_width': 2,
                'max_nodes': 60, 'seconds': 1.25, 'selection': 'highest win estimate on a shared endpoint with the direct choice; direct policy otherwise'}}
    if args.mode == 'micro':
        metadata['search'] = {'mode': 'micro', 'width': 2, 'main_action_depth': 3, 'max_nodes': 40,
                              'seconds': .28, 'small_menu_max': 6, 'boundary': 'opponent turn or round resolution'}
    metadata.update(shard=args.shard, shards=args.shards)
    rows = []
    started = perf_counter()
    jobs = [(seed, seat, manifest['rules'], output, args.mode) for seed in seeds for seat in range(2)]

    def record(results, log):
        for row in results:
            rows.append(row)
            log.write(json.dumps(row) + '\n')
            log.flush()
            if args.mode == 'micro' or len(rows) % 8 == 0 or row['failure']:
                print(json.dumps({'played': len(rows), 'total': len(jobs), 'wins': sum(r['win'] for r in rows),
                                  'failures': sum(bool(r['failure']) for r in rows), 'last_failure': row['failure']}), flush=True)

    with (output / 'games.jsonl').open('x', encoding='utf-8') as log:
        if args.workers == 1:
            initialize(engine, checkpoint)
            record((run_game(*job) for job in jobs), log)
        else:
            with ProcessPoolExecutor(max_workers=args.workers, initializer=initialize, initargs=(engine, checkpoint)) as pool:
                work = [pool.submit(run_game, *job) for job in jobs]
                record((future.result() for future in as_completed(work)), log)
    results = metadata | summarize(rows) | {'wall_seconds': round(perf_counter() - started, 2)}
    (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(results), flush=True)


if __name__ == '__main__':
    main()
