"""Play the learned move policy against Easy on matched two- and four-player boards."""

import argparse
from concurrent.futures import ProcessPoolExecutor
import importlib
import json
import os
from pathlib import Path
from statistics import mean

training = importlib.import_module('train-nations')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('policy', type=Path)
    parser.add_argument('--boards', type=int, default=12)
    parser.add_argument('--seed', type=int, default=28743400)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.boards < 1 or args.workers < 1 or args.output.exists():
        parser.error('Use positive board and worker counts and a new output path.')

    learned = json.loads(args.policy.read_text(encoding='utf-8'))
    easy_path = training.ROOT / 'live-player/trained-weights.json'
    easy = json.loads(easy_path.read_text(encoding='utf-8'))
    os.environ['NATIONS_PLAYER_WEIGHTS'] = str(easy_path)
    report = {'first_seed': args.seed, 'boards_per_player_count': args.boards,
              'policy': str(args.policy.resolve()), 'profiles': {}}
    with ProcessPoolExecutor(max_workers=args.workers, initializer=training.initialize) as pool:
        for count in (2, 4):
            seeds = range(args.seed + 100 * count, args.seed + 100 * count + args.boards)
            rows, summaries = training.evaluate(pool, {'humanPolicy': learned, 'easyControl': easy}, count, seeds, [easy])
            by_board = {seed: {label: [] for label in summaries} for seed in seeds}
            for row in rows:
                by_board[row['seed']][row['label']].append(row)
            differences = []
            for game in by_board.values():
                if any(len(group) != count or any(row['error'] for row in group) for group in game.values()):
                    continue
                differences.append(mean(row['reward'] for row in game['humanPolicy']) - mean(row['reward'] for row in game['easyControl']))
            report['profiles'][count] = {'summaries': summaries, 'complete_board_pairs': len(differences),
                'mean_paired_delta': mean(differences) * (4 if count == 4 else 1) if differences else None,
                'games': rows}
            training.atomic_json(args.output, report)
            print(json.dumps({'playerCount': count, 'summaries': summaries, 'complete_boards': len(differences)}), flush=True)


if __name__ == '__main__':
    main()
