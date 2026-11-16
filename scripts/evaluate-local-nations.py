"""Benchmark the browser bot against simpler opponents on seat-rotated boards."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from hashlib import sha256
from importlib import import_module
import json
import os
from pathlib import Path
import random
from statistics import mean
import sys
from time import perf_counter

from nations_human_player import choose_human_move
from nations_policy import ROOT, SharedScorer


local_game = import_module('serve-nations').LocalGame
atomic_json = import_module('train-nations').atomic_json
LEAGUE_POINTS = (5, 3, 2, 1)
RULES = dict(growth_resources=2, extra_draft_nations=1, resource_remainder_tiebreaker=True,
             card_draw_limits=True, korea_nerf=True, lincoln_nerf=True)
_scorer = None
_previous = None


def initialize(policy_path, previous_directory=None):
    global _scorer, _previous
    sys.path.insert(0, str(ROOT.parent / 'nations-server/Nations'))
    _scorer = SharedScorer()
    _scorer.request({'loadHumanPolicy': json.loads(policy_path.read_text(encoding='utf-8'))})
    if previous_directory:
        _previous = SharedScorer(previous_directory/'local-bridge.mjs')
        _previous.request({'loadHumanPolicy': json.loads((previous_directory/'human-baseline.json').read_text(encoding='utf-8'))})


def simulate(task):
    from nations import Match

    count, opponent, seed, seat, output = task
    names = [f'Player{index}' for index in range(count)]
    human_policy = names[seat]
    _scorer.configure({name: 'v02' for name in names if name != human_policy} if opponent == 'v02' else {})
    planned_deployments = {}
    previous_deployments = {}
    dynasty_events = []
    started = perf_counter()
    decisions = 0

    def choose(prompt, options, _undo):
        nonlocal decisions
        decisions += 1
        if decisions > 1800 or perf_counter() - started > 120:
            raise RuntimeError('Decision or time limit exceeded')
        if match.invalid_move or not options:
            raise RuntimeError(f'{match.next_move_player}: {match.invalid_move or "no choices for " + prompt}')
        legal = {str(option): option for option in options}
        if match.next_move_player == human_policy:
            selected, _ = choose_human_move(_scorer, match, local_game.replay_position, planned_deployments)
            if selected.startswith('Play "') or prompt == 'Play which dynasty?':
                dynasty_events.append({'round': match.round_number, 'choice': selected})
        elif opponent == 'baseline-v1':
            selected, _ = choose_human_move(_previous, match, local_game.replay_position, previous_deployments)
        elif len(options) == 1:
            return options[0]
        else:
            selected = _scorer.choose(match.get_state())
        if selected not in legal:
            raise RuntimeError(f'{match.next_move_player}: unavailable choice {selected!r} for {prompt}')
        return legal[selected]

    match = Match(player_names=names, seed=f'{seed:x}', move_getter=choose, rules=RULES)
    row = {'players': count, 'opponent': opponent, 'seed': seed, 'seat': seat, 'error': None}
    try:
        match.play()
        if match.phase.name != 'SCORING' or match.round_number != 8:
            raise RuntimeError('Game ended before round-eight scoring')
        ordered = sorted(match.players, key=lambda player: (-player.score(), -player.resource_remainder()))
        place = next(index for index, player in enumerate(ordered, 1) if player.name == human_policy)
        scores = {player.name: player.score() for player in ordered}
        row.update(place=place, vp=scores[human_policy], scores=scores,
                   vp_margin=scores[human_policy] - mean(score for name, score in scores.items() if name != human_policy),
                   league_points=LEAGUE_POINTS[place-1] if count == 4 else None)
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {error}'
        row['failed_actor'] = match.next_move_player
        row['failed_prompt'] = match.next_move_choice
    replay = f'{count}p-{opponent}-{seed}-{seat}.replay'
    (output/'replays'/replay).write_text(match.get_replay(),encoding='utf-8')
    row.update(replay=replay, decisions=match.move_number, round=match.round_number,
               nation=next((p.nation.name for p in match.players if p.name == human_policy and p.nation), None),
               dynasty_events=dynasty_events,
               duration_seconds=round(perf_counter() - started, 2))
    return row


def summarize(rows, count):
    complete = [row for row in rows if 'place' in row]
    wins = sum(row.get('place') == 1 for row in rows)
    same_board = defaultdict(list)
    for row in rows:
        same_board[row['seed']].append(float(row.get('place') == 1))
    board_rates = [mean(rate) for rate in same_board.values() if len(rate) == count]
    interval = None
    if len(board_rates) > 1:
        rng = random.Random(8750)
        estimates = sorted(mean(rng.choices(board_rates, k=len(board_rates))) for _ in range(4000))
        interval = [estimates[100], estimates[3899]]
    return {
        'attempted': len(rows), 'completed': len(complete), 'wins': wins,
        'win_rate_all_games': wins / len(rows),
        'win_rate_completed_games': wins / len(complete) if complete else None,
        'paired_board_bootstrap_95': interval,
        'placements': dict(Counter(row['place'] for row in complete)),
        'mean_vp_margin': mean(row['vp_margin'] for row in complete) if complete else None,
        'mean_league_points': mean(row['league_points'] for row in complete) if complete and count == 4 else None,
        'failures': dict(Counter(row['error'] for row in rows if row['error'])),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('policy', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--boards',type=int,default=32,help='Two-player boards per opponent, with both seats played.')
    parser.add_argument('--four-player-boards',type=int,default=12,help='Boards against three Easy bots. Use 0 to skip.')
    parser.add_argument('--seed',type=int,default=61361000)
    parser.add_argument('--workers',type=int,default=6)
    parser.add_argument('--previous-directory',type=Path,help='Archived v1 live-player directory for exact old-baseline comparisons.')
    args = parser.parse_args()
    if args.boards < 1 or args.four_player_boards < 0 or args.workers < 1 or args.seed < 1 or args.output.exists():
        parser.error('Choose a new output directory and valid board, worker and seed counts.')

    weights = ROOT/'live-player/trained-weights.json'
    os.environ['NATIONS_PLAYER_WEIGHTS'] = str(weights)
    report = {'rules': RULES, 'first_seed': args.seed, 'human_policy_sha256': sha256(args.policy.read_bytes()).hexdigest(),
              'easy_weights_sha256': sha256(weights.read_bytes()).hexdigest(), 'groups': {}}
    (args.output/'replays').mkdir(parents=True)
    groups = [(2, 'easy', args.boards), (2, 'v02', args.boards), (4, 'easy', args.four_player_boards)]
    if args.previous_directory:
        if not (args.previous_directory/'local-bridge.mjs').is_file(): parser.error('Previous directory must contain the archived bridge.')
        groups.extend([(2, 'baseline-v1', args.boards), (4, 'baseline-v1', args.four_player_boards)])
    with ProcessPoolExecutor(max_workers=args.workers, initializer=initialize, initargs=(args.policy.resolve(), args.previous_directory.resolve() if args.previous_directory else None)) as pool:
        for count, opponent, boards in groups:
            if not boards:
                continue
            tasks = [(count, opponent, seed, seat, args.output.resolve())
                     for seed in range(args.seed + count*100, args.seed + count*100 + boards) for seat in range(count)]
            key = f'{count}p/{opponent}'
            rows = []
            for finished in as_completed([pool.submit(simulate, task) for task in tasks]):
                rows.append(finished.result())
                if len(rows) % 8 == 0 or len(rows) == len(tasks):
                    print(json.dumps({'group': key, 'played': len(rows), 'total': len(tasks),
                                      'wins': sum(row.get('place') == 1 for row in rows),
                                      'failures': sum(bool(row['error']) for row in rows)}), flush=True)
            rows.sort(key=lambda row: (row['seed'], row['seat']))
            report['groups'][key] = {'summary': summarize(rows, count), 'games': rows}
            atomic_json(args.output/'results.json', report)
            print(json.dumps({'group': key, 'summary': report['groups'][key]['summary']}), flush=True)


if __name__ == '__main__':
    main()
