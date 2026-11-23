"""Distill confirmed round-search overrides into the frozen move policy."""
import argparse
from collections import Counter
from pathlib import Path
from random import Random
import sys

import numpy as np
import torch
from torch.nn import functional as F

from compare_position_checkpoints import read, run_wave
from compare_position_encoding import StaticFallback, card_catalog, load_structured, position_encoder
from compare_position_microsearch import MicroPlayer
from model import collate
from train import ROOT, digest, emit, seed_all, write_json
from train_round_value import RoundEncoder, load_round_value
from tune_round_value import IncompletePair, collect_board, play_line


def perturbed(predict, seed):
    """Occasionally try a plausible policy alternative after settlement."""
    rng = Random(seed)

    def choose(state):
        prediction = predict(state)
        moves = prediction['moves']
        if len(moves) >= 2 and moves[1].get('policy_gap', float('inf')) <= 2 and rng.random() < .15:
            return {**prediction, 'moves': [moves[1], moves[0], *moves[2:]]}
        return prediction

    return choose


def worker(manifest_path, jobs_path):
    setup = read(manifest_path)
    batch, output = Path(setup['batch']), manifest_path.parent
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match

    seed_all(setup['seed'], 1)
    base = setup['challenger']
    model = load_structured(Path(base['path']), base['encoding']).requires_grad_(False)
    encoder = position_encoder(batch, base['encoding'])
    round_encoder = RoundEncoder(card_catalog(batch))
    evaluate = load_round_value(batch, setup['value_head'])
    fallback = StaticFallback(batch)
    policy = MicroPlayer(model, encoder, fallback, '', None, policy_rollouts=True)

    def examples(source, index, number):
        rows, counts = [], Counter()

        def collect(prefix, state, direct, selected, lines):
            features, moves = encoder.encode(state)
            if direct.moves[0] not in moves or selected.moves[0] not in moves:
                counts['unsupported choice'] += 1
                return
            results = [tuple(line[1:] for line in lines)]
            for variant in range(2):
                seed = f'{setup["seed"]}/{number}/{state["move_number"]}/{state["next_move_player"]}/{variant}'
                try:
                    results.append(tuple(play_line(
                        Match, prefix, state, candidate.moves, policy.predict, round_encoder,
                        continue_predict=perturbed(policy.predict, seed))[1:] for candidate in (direct, selected)))
                except IncompletePair as error:
                    counts[str(error)] += 1
                    return
            signs = [(after > before) - (after < before) for before, after in results]
            counts['checked'] += 1
            if signs.count(1) < 2:
                counts['search override rejected'] += 1
                return
            counts['unanimous'] += signs.count(1) == 3
            rows.append({**features, 'chosen': moves.index(selected.moves[0]),
                         'weight': 1. if signs.count(1) == 3 else .55})

        _, base_counts = collect_board(Match, source, index, policy, evaluate, round_encoder, setup, on_pair=collect)
        counts.update(base_counts)
        return rows, counts

    try:
        for number, source, index, split in read(jobs_path):
            rows, counts = examples(Path(source), index, number)
            if rows:
                batch_rows = collate(rows)
                np.savez_compressed(output / 'examples' / f'{number:04}.npz',
                                    **{key: value.numpy() for key, value in batch_rows.items()},
                                    chosen=[row['chosen'] for row in rows], weight=[row['weight'] for row in rows])
            write_json(output / 'boards' / f'{number:04}.json',
                       {'split': split, 'counts': dict(counts), 'labels': len(rows)})
    finally:
        fallback.close()


def fit(output, setup):
    by_split = {split: [] for split in ('train', 'validation', 'test')}
    counts = Counter()
    for path in sorted((output / 'boards').glob('*.json')):
        board = read(path)
        counts.update(board['counts'])
        if not board['labels']:
            continue
        with np.load(output / 'examples' / f'{path.stem}.npz', allow_pickle=False) as saved:
            target = by_split[board['split']]
            for i, mask in enumerate(saved['mask']):
                length = int(mask.sum())
                target.append({'sn': saved['sn'][i], 'st': saved['st'][i],
                               'an': saved['an'][i, :length], 'at': saved['at'][i, :length],
                               'chosen': saved['chosen'][i], 'weight': saved['weight'][i]})
    if not all(by_split.values()):
        raise ValueError('Every split needs at least one confirmed search target')
    seed_all(setup['seed'], 4)
    info = setup['challenger']
    anchor = load_structured(Path(info['path']), info['encoding']).requires_grad_(False)
    model = load_structured(Path(info['path']), info['encoding']).requires_grad_(False)
    model.policy.requires_grad_(True)
    optimizer = torch.optim.AdamW(model.policy.parameters(), lr=3e-4)
    rng = Random(setup['seed'])

    def measure(current, rows):
        correct, seen, loss = 0, 0, 0.
        with torch.inference_mode():
            for start in range(0, len(rows), 128):
                chunk = rows[start:start + 128]
                chosen = torch.tensor([row['chosen'] for row in chunk])
                logits, _ = current(collate(chunk))
                seen += len(chunk)
                correct += int((logits.argmax(-1) == chosen).sum())
                loss += F.cross_entropy(logits, chosen, reduction='sum').item()
        return {'total': seen, 'matching_teacher': correct, 'teacher_loss': loss / seen}

    train = by_split['train']
    best, history = None, []
    for epoch in range(1, setup['epochs'] + 1):
        rng.shuffle(train)
        for start in range(0, len(train), 64):
            rows = train[start:start + 64]
            batch = collate(rows)
            chosen = torch.tensor([r['chosen'] for r in rows])
            weights = torch.tensor([r['weight'] for r in rows], dtype=torch.float32)
            with torch.no_grad():
                reference, _ = anchor(batch)
            logits, _ = model(batch)
            imitate = (F.cross_entropy(logits, chosen, reduction='none') * weights).mean()
            retain = F.kl_div(logits.log_softmax(-1), reference.softmax(-1), reduction='batchmean')
            optimizer.zero_grad()
            (imitate + .5 * retain).backward()
            optimizer.step()
        metric = measure(model, by_split['validation'])
        if not history or metric['teacher_loss'] < min(row['teacher_loss'] for row in history):
            best = {key: value.clone() for key, value in model.state_dict().items()}
        history.append(metric)
        emit({'epoch': epoch, 'validation': metric})
    for key, value in anchor.state_dict().items():
        if not key.startswith('policy.') and not torch.equal(value, best[key]):
            raise ValueError('A frozen layer changed during distillation')
    model.load_state_dict(best)
    saved = torch.load(info['path'], weights_only=True, map_location='cpu')
    torch.save({**saved, 'parameters': best}, output / 'structured.pt')
    result = {'examples': {name: len(rows) for name, rows in by_split.items()}, 'collection': dict(counts),
              'validation': history, 'selected_epoch': 1 + min(range(len(history)),
                                                               key=lambda i: history[i]['teacher_loss']),
              'test': {name: measure(current, by_split['test']) for name, current in
                       (('original', anchor), ('distilled', model))}}
    write_json(output / 'results.json', result)
    emit(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--epochs', type=int, default=5)
    parser.add_argument('--pairs-per-round', type=int, default=2)
    parser.add_argument('--seed', type=int, default=201161)
    args = parser.parse_args()
    if min(args.workers, args.epochs, args.pairs_per_round) < 1:
        parser.error('Training limits must be positive')
    sources = [p.resolve() for p in args.source]
    original = read(sources[0] / 'manifest.json')
    setup = {key: original[key] for key in ('batch', 'challenger', 'rule_mix', 'search', 'value_head')}
    boards = []
    for source in sources:
        manifest = read(source / 'manifest.json')
        if any(manifest[key] != value for key, value in setup.items()):
            raise ValueError('Search teacher archives use different checkpoints or settings')
        boards.extend((seed, str(source), index) for index, seed in enumerate(manifest['boards']))
    if len(boards) < 12 or len({seed for seed, _, _ in boards}) != len(boards):
        raise ValueError('Need distinct boards for disjoint evaluation splits')
    for key in ('challenger', 'value_head'):
        if digest(Path(setup[key]['path'])) != setup[key]['sha256']:
            raise ValueError('Frozen source checkpoint changed')
    Random(args.seed).shuffle(boards)
    holdout = max(2, len(boards) // 8)
    jobs = [(number, source, index, 'test' if number < holdout else
             'validation' if number < 2 * holdout else 'train')
            for number, (_, source, index) in enumerate(boards)]
    output = args.output.resolve()
    for subdir in ('boards', 'examples'):
        (output / subdir).mkdir(parents=True)
    setup.update(seed=args.seed, epochs=args.epochs, pairs_per_round=args.pairs_per_round,
                 board_seeds=[seed for seed, _, _ in boards])
    write_json(output / 'manifest.json', setup)
    emit({'stage': 'collecting search labels', 'boards': len(boards), 'continuations_per_choice': 3})
    run_wave(output / 'manifest.json', jobs, args.workers, 0, worker_script=__file__)
    fit(output, setup)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
