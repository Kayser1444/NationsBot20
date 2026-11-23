"""Evaluate frozen value heads on fresh pairs with different action allowances."""
import argparse
from collections import Counter
from pathlib import Path
from random import Random
from statistics import mean
import sys
from time import perf_counter

import torch

from compare_position_checkpoints import read, run_wave
from compare_position_encoding import StaticFallback, load_structured, position_encoder
from compare_position_microsearch import MicroPlayer
from compare_reading_continuations import rollout
from mixed_rules import RULE_MIX, rules_for_board
from train import ROOT, board_seed, digest, emit, play_game, seed_all, write_json
from train_handoff_value import (FEATURES, board_embedding, fit, initialize_head, load_training_data,
                                metrics, ranking_change, score_pairs, turn_features)


def spending_line(prefix, root, move, predict, trace, deadline):
    from nations_microsearch import MAIN

    path = [move]
    while True:
        position = trace(prefix, root, tuple(path), deadline, pre_move=True, capture_handoff=True)
        if position.boundary is not None:
            return path, position
        if position.state['next_move_choice'] == MAIN:
            return path, position
        path.append(predict(position.state)['moves'][0]['move'])


def sample_board(match_type, encoder, model, fallback, direct, trace, output, seed, rules, index, rng):
    from nations_lookahead import SearchBudget
    from nations_microsearch import MAIN

    roots = []
    failures = Counter()

    def capture(match, state, _options):
        if (state['next_move_choice'] == MAIN and match.phase.name == 'ACTION'
                and match.current_player.remaining_main_actions == 1
                and all(not p.passed for p in match.players)
                and any(move.startswith('Undeploy from ') for move in state['next_move_options'])):
            roots.append((state, match.get_replay()))

    game, _ = play_game(match_type, encoder, fallback, {'Seat0': model, 'Seat1': model}, (), seed, None,
                        sample=False, sampling_seed=0, seconds=60, move_override=capture, rules=rules)
    if game['error']:
        return None, {game['error']: 1}
    rng.shuffle(roots)
    for root, prefix in roots:
        owner = root['next_move_player']
        moves = [row['move'] for row in direct.predict(root)['moves']]
        undeploy = next(move for move in moves if move.startswith('Undeploy from '))
        spending = next((move for move in moves if not move.startswith('Undeploy from ') and move != 'Pass'), None)
        if spending is None:
            continue
        deadline = perf_counter() + 10
        try:
            available = trace(prefix, root, (undeploy,), deadline, pre_move=True, capture_handoff=True)
            if (available.boundary or available.state['next_move_choice'] != MAIN
                    or available.state['next_move_player'] != owner
                    or available.remaining_main_actions[owner] != 1):
                continue
            line, spent = spending_line(prefix, root, spending, direct.predict, trace, deadline)
            if spent.boundary != 'opponent turn' or spent.state['remaining_main_actions'][owner] != 0:
                continue
            pair = []
            for label, path, position in (('available', [undeploy], available), ('spent', line, spent)):
                state = position.state
                next_player = owner if label == 'available' else state['handoff_next_player']
                counts = available.remaining_main_actions if label == 'available' else state['remaining_main_actions']
                result = rollout(match_type, prefix, root, path, direct.predict,
                                 output / 'replays' / f'{index:04}-{root["move_number"]}-{label}.replay')
                pair.append({**result, 'board': board_embedding(encoder, model, state, owner).tolist(),
                             'turn': turn_features(state, owner, next_player, counts, starts_turn=label == 'spent'),
                             'moves': path, 'remaining_main_actions': counts[owner], 'next_player': next_player})
            return {'index': index, 'seed': seed, 'rules': rules, 'round': root['round'],
                    'move_number': root['move_number'], 'owner': owner, 'policy_move': moves[0],
                    'pair': pair}, dict(failures)
        except (ValueError, AttributeError, KeyError, SearchBudget) as error:
            failures[f'{type(error).__name__}: {error}'] += 1
    return None, dict(failures)


def worker(manifest_path, jobs_path):
    setup = read(manifest_path)
    batch = Path(setup['batch'])
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from nations_microsearch import trace

    seed_all(setup['seed'], 1)
    encoder = position_encoder(batch, setup['encoding'])
    model = load_structured(Path(setup['challenger']['path']), setup['encoding'])
    fallback = StaticFallback(batch)
    output = manifest_path.parent
    try:
        direct = MicroPlayer(model, encoder, fallback, '', None, strict_direct=True)
        for index in read(jobs_path):
            seed = board_seed('action-allowance-holdout-v1', setup['seed'], index)
            sample, failures = sample_board(Match, encoder, model, fallback, direct, trace, output, seed,
                                            rules_for_board(setup['seed'], index), index, Random(setup['seed'] + index))
            write_json(output / 'boards' / f'{index:04}.json', {'sample': sample, 'failures': failures})
    finally:
        fallback.close()


def load_heads(model, training, setup):
    heads = {}
    for name, filename in (('turn_aware', 'turn-aware-value.pt'), ('retrained_control', 'control-value.pt')):
        path = training / filename
        if path.exists():
            saved = torch.load(path, weights_only=True, map_location='cpu')
            features = FEATURES if name == 'turn_aware' else ()
            if saved['policy_sha256'] != setup['challenger']['sha256'] or tuple(saved['turn_features']) != features:
                raise ValueError('The value head uses a different policy or turn schema')
            head = initialize_head(model, len(features))
            head.load_state_dict(saved['parameters'])
            heads[name] = head.eval()
    if 'retrained_control' not in heads:
        data = load_training_data(training)
        train = (data['game'] < setup['requested_games']).nonzero().flatten()
        validation = ((data['game'] >= setup['requested_games']) & (data['stage'] != 0)).nonzero().flatten()
        trained, results = fit(model, data, train, validation, setup['seed'], setup['epochs'])
        original = read(training / 'results.json')['fit']['retrained_control']
        if abs(original['validation_bce'] - results['retrained_control']['validation_bce']) > 1e-6:
            raise ValueError('Control refit did not reproduce the original validation result')
        heads['retrained_control'] = trained['retrained_control']
    return heads


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--training', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--boards', type=int, default=256)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--seed', type=int, default=181181)
    args = parser.parse_args()
    if min(args.boards, args.workers) < 1:
        parser.error('Board and worker counts must be positive')
    training, output = args.training.resolve(), args.output.resolve()
    original = read(training / 'manifest.json')
    checkpoint = Path(original['challenger']['path'])
    if digest(checkpoint) != original['challenger']['sha256'] or original['rule_mix'] != RULE_MIX:
        raise ValueError('Checkpoint or rule settings differ from training')
    (output / 'boards').mkdir(parents=True)
    (output / 'replays').mkdir()
    setup = {**original, 'seed': args.seed, 'boards': args.boards, 'training': str(training)}
    manifest = output / 'manifest.json'
    write_json(manifest, setup)
    emit({'stage': 'paired rollouts', 'boards': args.boards})
    blocked = {board_seed('handoff-value-training-v1', original['seed'], i)
               for i in range(original['requested_games'] + original['validation_games'])}
    source = Path(original['source'])
    blocked.update(read(path)['seed'] for path in (source / 'boards').glob('*.json'))
    samples, failures = [], Counter()
    attempted = wave = 0
    while len(samples) < args.boards:
        indexes = range(attempted, attempted + args.boards - len(samples))
        if any(board_seed('action-allowance-holdout-v1', args.seed, i) in blocked for i in indexes):
            raise ValueError('A held-out board overlaps the previous data')
        run_wave(manifest, list(indexes), args.workers, wave, worker_script=__file__)
        previous = len(samples)
        for index in indexes:
            result = read(output / 'boards' / f'{index:04}.json')
            failures.update(result['failures'])
            if result['sample'] is not None:
                samples.append(result['sample'])
        if len(samples) == previous:
            raise ValueError('No comparable positions found in this wave')
        attempted = indexes.stop
        wave += 1
    seed_all(original['seed'], 4)
    model = load_structured(checkpoint, original['encoding']).requires_grad_(False)
    heads = load_heads(model, training, original)
    pairs = [sample['pair'] for sample in samples]
    with torch.inference_mode():
        score_pairs(model, heads, pairs)
    names = ('frozen_100k', 'retrained_control', 'turn_aware')
    report = {'positions': len(pairs), 'games': 2 * len(pairs), 'attempted_boards': attempted,
              'excluded_attempts': dict(failures),
              'raw_outcomes': {label: {'wins': sum(pair[i]['won'] for pair in pairs),
                                       'mean_vp': mean(pair[i]['margin'] for pair in pairs)}
                               for i, label in enumerate(('available', 'spent'))},
              'results': {name: metrics(pairs, name) for name in names},
              'ranking_change': {base: {key: ranking_change(pairs, base, 'turn_aware', key)
                                        for key in ('won', 'margin')} for base in names[:-1]}}
    for sample in samples:
        for line in sample['pair']:
            del line['board']
    write_json(output / 'scored-pairs.json', samples)
    write_json(output / 'results.json', report)
    emit(report)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
