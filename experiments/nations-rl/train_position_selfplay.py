"""Matched PPO self-play for the legacy and structured current-position encoders."""
import argparse
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import random
import subprocess
import sys
from time import time

import numpy as np
import torch

from compare_position_encoding import StaticFallback, card_catalog, expand, load_structured
from encoding import Encoder
from model import collate, load_model, save_model
from position_encoding import PositionEncoder, SCHEMA
from train import ROOT, RULES, board_seed, digest, emit, play_game, ppo_update, seed_all, write_json


NAMES = ('Seat0', 'Seat1')
ARMS = ('control', 'structured')
SCALARS = ('label', 'old_logprob', 'old_value', 'target')
BOARD_ARRAYS = ('sn', 'st')
ACTION_ARRAYS = ('an', 'at')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def collect_games(match_type, encoder, model, fallback, episodes, path, reference_logits=None):
    models = dict.fromkeys(NAMES, model)
    games, samples = [], []
    for seed, sampling_seed, *settings in episodes:
        replay = path.with_name(f'{path.stem}-{seed[:12]}-failed.replay')
        game, trajectory = play_game(match_type, encoder, fallback, models, NAMES, seed, None,
                                     sample=True, sampling_seed=sampling_seed, seconds=90,
                                     failure_output=replay, reference_logits=reference_logits,
                                     rules=settings[0] if settings else None)
        games.append(game)
        samples.extend(trajectory)
    write_json(path.with_suffix('.games.json'), games)
    if samples:
        action_keys = ACTION_ARRAYS + (('reference_logits',) if reference_logits is not None else ())
        np.savez(path.with_suffix('.npz'),
                 lengths=np.asarray([len(row['an']) for row in samples]),
                 **{key: np.stack([row[key] for row in samples]) for key in BOARD_ARRAYS},
                 **{key: np.concatenate([row[key] for row in samples]) for key in action_keys},
                 **{key: np.asarray([row[key] for row in samples]) for key in SCALARS})
    return games, bool(samples)


def collect(path):
    task = read_json(path)
    batch, checkpoint = Path(task['batch']), Path(task['checkpoint'])
    seed_all(task['seed'], 1)
    sys.path.insert(0, str(batch / 'snapshot/engine'))
    from nations import Match

    cards = card_catalog(batch)
    if task['arm'] == 'structured':
        encoder, model = PositionEncoder(cards), load_structured(checkpoint)
    else:
        encoder, model = Encoder(cards), load_model(checkpoint)[0].eval()
    fallback = StaticFallback(batch)
    try:
        games, have_samples = collect_games(Match, encoder, model, fallback, task['episodes'], path)
    finally:
        fallback.close()
    if len(games) != len(task['episodes']) or any(game['error'] for game in games) or not have_samples:
        raise RuntimeError(f'Incomplete self-play in {path.name}')


def collected_samples(path):
    with np.load(path, allow_pickle=False) as arrays:
        lengths = arrays['lengths']
        board = {key: arrays[key] for key in BOARD_ARRAYS}
        actions = {key: arrays[key] for key in ACTION_ARRAYS}
        if 'reference_logits' in arrays:
            actions['reference_logits'] = arrays['reference_logits']
        labels = {key: arrays[key].tolist() for key in SCALARS}
    rows, start = [], 0
    for index, length in enumerate(lengths):
        end = start + int(length)
        rows.append({**{key: values[index] for key, values in board.items()},
                     **{key: values[start:end] for key, values in actions.items()},
                     **{key: values[index] for key, values in labels.items()}})
        start = end
    return rows


def collect_round(args, directory, episodes):
    # Independent interpreters keep CPU-bound engine work off the same Python thread.
    workers = min(args.workers, len(episodes))
    jobs = [(arm, episodes[index * len(episodes) // workers:(index + 1) * len(episodes) // workers])
            for index in range(workers) for arm in ARMS]
    # Process both arms together, distributing the same episode ranges to each.
    jobs_per_wave = workers
    files = {arm: [] for arm in ARMS}
    start = time()
    for index in range(0, len(jobs), jobs_per_wave):
        running = []
        for slot, (arm, assigned) in enumerate(jobs[index:index + jobs_per_wave], start=index):
            path = directory / f'{slot:02}-{arm}.json'
            write_json(path, {'arm': arm, 'batch': str(args.batch), 'seed': args.seed,
                              'checkpoint': str(args.output / f'{arm}.pt'), 'episodes': assigned})
            files[arm].append(path)
            with path.with_suffix('.log').open('w', encoding='utf-8') as log:
                process = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '--collect', str(path)],
                                           stdout=log, stderr=subprocess.STDOUT)
            running.append((process, path))
        failures = [path.name for process, path in running if process.wait()]
        if failures:
            raise RuntimeError(f'Self-play workers failed; see logs for {", ".join(failures)}')
    return files, {'start': start, 'end': time(), 'games': 2 * len(episodes),
                   'workers': workers}


def save_pair(args, models, checkpoint_hash, games):
    metadata = {'kind': 'matched-self-play', 'games_per_arm': games, 'benchmark': checkpoint_hash}
    save_model(args.output / 'control.pt', models['control'], metadata)
    model = models['structured']
    torch.save({'encoding_version': SCHEMA, 'config': model.config,
                'parameters': model.state_dict(), 'metadata': metadata}, args.output / 'structured.pt')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch', type=Path, default=ROOT / '.data/nations-rl/batch-10000-v1')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--rounds', type=int, default=2)
    parser.add_argument('--games-per-round', type=int, default=48, help='Self-play games per arm per PPO update.')
    parser.add_argument('--workers', type=int, default=6, help='Maximum simultaneous game worker processes.')
    parser.add_argument('--seed', type=int, default=181127)
    parser.add_argument('--learning-rate', type=float, default=.0001)
    args = parser.parse_args()
    if min(args.rounds, args.games_per_round, args.workers) < 1:
        parser.error('Rounds, games and workers must be positive')
    args.batch, args.output = args.batch.resolve(), args.output.resolve()
    frozen = read_json(args.batch / 'manifest.json')
    if frozen['rules'] != RULES:
        raise ValueError('Training rules differ from the frozen benchmark')
    checkpoint = args.batch / read_json(args.batch / 'selection.json')['selected']
    checkpoint_hash = digest(checkpoint)
    seed_all(args.seed, min(args.workers, 4))
    old, _ = load_model(checkpoint)
    encoder = PositionEncoder(card_catalog(args.batch))
    example, _ = encoder.encode({'next_move_player': NAMES[0], 'next_move_choice': 'Which action?',
                                 'player_order': NAMES, 'next_move_options': ['Pass', 'Turmoil'],
                                 'players': dict.fromkeys(NAMES, {})})
    models = {'control': old, 'structured': expand(old, example)}
    old_example = {**example, 'sn': example['sn'][:old.config['state_size']],
                   'an': example['an'][:, :old.config['action_size']]}
    with torch.no_grad():
        for old_result, new_result in zip(old(collate([old_example])), models['structured'](collate([example]))):
            torch.testing.assert_close(old_result, new_result, atol=1.e-5, rtol=1.e-5)
    anchors = {arm: deepcopy(model).eval() for arm, model in models.items()}
    optimizers = {arm: torch.optim.Adam(model.parameters(), lr=args.learning_rate)
                  for arm, model in models.items()}
    human_boards = set(frozen['human_seed_hashes'])
    args.output.mkdir(parents=True)
    (args.output / 'replays').mkdir()
    write_json(args.output / 'manifest.json', {
        'arguments': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
        'rules': RULES, 'benchmark_sha256': checkpoint_hash, 'encoding': SCHEMA,
        'training': 'matched-ppo-self-play',
        'source_sha256': {name: digest(Path(__file__).with_name(name)) for name in (
            'train_position_selfplay.py', 'compare_position_encoding.py', 'position_encoding.py',
            'encoding.py', 'model.py', 'train.py')},
    })
    save_pair(args, models, checkpoint_hash, 0)
    history = []
    for update in range(args.rounds):
        first = update * args.games_per_round
        end = first + args.games_per_round
        episodes = [(board_seed('current-position-self-play', args.seed, index), args.seed + index)
                    for index in range(first, end)]
        if any(sha256(bytes.fromhex(seed)).hexdigest() in human_boards for seed, _ in episodes):
            raise ValueError('Generated self-play board overlaps the human corpus')
        directory = args.output / f'update-{update + 1:02}'
        directory.mkdir()
        emit({'stage': 'collect', 'round': update + 1, 'games_per_arm': len(episodes), 'workers': args.workers})
        files, timing = collect_round(args, directory, episodes)
        games = {arm: [game for path in files[arm] for game in read_json(path.with_suffix('.games.json'))] for arm in ARMS}
        for arm in ARMS:
            if [game['seed'] for game in games[arm]] != [seed for seed, _ in episodes]:
                raise ValueError(f'Self-play board mismatch in {arm}')
        metrics = {}
        update_started = time()
        for arm in ARMS:
            rows = [row for path in files[arm] for row in collected_samples(path.with_suffix('.npz'))]
            model = models[arm]
            model.train()
            metrics[arm] = ppo_update(model, anchors[arm], rows, optimizers[arm], random.Random(args.seed + update))
            del rows
        save_pair(args, models, checkpoint_hash, end)
        for path in (path for arm in ARMS for path in files[arm]):
            path.with_suffix('.npz').unlink()
        record = {'round': update + 1, 'games_per_arm': end, 'collection': timing,
                  'optimization': {'start': update_started, 'end': time()}, 'ppo': metrics}
        history.append(record)
        write_json(args.output / 'selfplay.json', history)
        emit({'stage': 'updated', **record})


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--collect':
        collect(Path(sys.argv[2]))
    else:
        main()
