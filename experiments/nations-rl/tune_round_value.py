"""Tune the frozen-policy round scorer on paired game continuations."""
import argparse
from collections import Counter
from pathlib import Path
from random import Random
import sys

import numpy as np
import torch
from torch import nn

from audit_policy_reading import committed_prompts
from compare_position_checkpoints import read, run_wave
from compare_position_encoding import StaticFallback, card_catalog, load_structured, position_encoder
from compare_position_microsearch import MicroPlayer
from train import ROOT, digest, emit, seed_all, write_json
from train_round_value import SCHEMA, RoundEncoder, load_round_value, round_observation, scorer


class AtRoot(Exception):
    pass


class IncompletePair(Exception):
    pass


def play_line(match_type, prefix, root, moves, predict, encoder, *, continue_predict=None):
    from nations_microsearch import ADMIN, ranked_choices
    from nations_move_safety import safe_architect_options, with_move_options

    owner, start = root['next_move_player'], root['move_number']
    settled = None
    calls = 0

    class Continuation(match_type):
        def resolution_phase(self):
            nonlocal settled
            super().resolution_phase()
            if self.round_number == root['round']:
                if self.move_number != start + len(moves):
                    raise IncompletePair('Settlement occurred at a different point in the line')
                settled = encoder.settled(round_observation(self), owner)

    def choose(prompt, options, _undo):
        nonlocal calls
        calls += 1
        if calls > 1800 or match.invalid_move:
            raise IncompletePair('Continuation hit a decision limit or invalid move')
        guarded = safe_architect_options(match, prompt, options)
        legal = {str(option): option for option in guarded if str(option) not in ADMIN}
        if not legal:
            raise IncompletePair('No playable choice in continuation')
        offset = match.move_number - start
        if offset == 0 and with_move_options(round_observation(match), guarded) != root:
            raise ValueError('Pair did not reproduce the recorded decision')
        if offset < len(moves):
            move = moves[offset]
        elif len(legal) == 1:
            move = next(iter(legal))
        else:
            state = with_move_options(round_observation(match), guarded)
            predictor = continue_predict if settled is not None and continue_predict is not None else predict
            move = ranked_choices(prompt, legal, predictor(state), all_moves=True)[0]
        if move not in legal:
            raise IncompletePair('A settled line became unavailable on replay')
        return legal[move]

    match = Continuation(replay=prefix, move_getter=choose)
    match.play()
    if settled is None or not match.game_over:
        raise IncompletePair('Game did not reach scoring')
    ordered = sorted(match.players, key=lambda p: (-p.score(), -p.resource_remainder()
                                                  if match.resource_remainder_tiebreaker else 0))
    points = {p.name: p.score() for p in ordered}
    return settled, int(ordered[0].name == owner), points[owner] - points[next(n for n in points if n != owner)]


def collect_board(match_type, source, index, policy, evaluate, encoder, setup, *, on_pair=None):
    from nations_microsearch import ADMIN, MAIN
    from nations_move_safety import safe_architect_options, with_move_options
    from nations_round_search import search_round

    board = read(source / 'boards' / f'{index:04}.json')
    rng = Random(f'{setup["seed"]}/{board["seed"]}')
    candidates = {number: [] for number in range(1, 8)}
    for game in board['games']:
        if game['error']:
            continue
        archive = (source / 'replays' / game['replay']).read_text(encoding='utf-8')
        prompts, scores = committed_prompts(match_type, archive, round_observation)
        if scores != game['scores']:
            raise ValueError('Training source replay does not reproduce its final scores')
        for state, prefix, choice in prompts:
            if (state['round'] in candidates and state['next_move_player'] == game['candidate']
                    and state['next_move_choice'] == MAIN and state['phase'] == 'Action Phase'
                    and len(set(state['next_move_options']) - ADMIN) > 1):
                candidates[state['round']].append((state, prefix, choice))
    rows, counts = [], Counter()
    for number in candidates:
        rng.shuffle(candidates[number])
        found = 0
        for archived, prefix, played in candidates[number]:
            prediction = policy.predict(archived)
            if prediction['moves'][0]['move'] == played:
                continue
            compared = []

            def choose(prompt, options, _undo):
                state = round_observation(match)
                if state != archived:
                    raise ValueError('Training source did not reproduce its root')
                guarded = safe_architect_options(match, prompt, options)
                state = with_move_options(state, guarded)
                search_round(match, state, guarded, policy.predict, policy.predict(state),
                             value_score=evaluate, observe=round_observation,
                             on_override=lambda direct, selected: compared.extend((state, direct, selected)),
                             **setup['search'])
                raise AtRoot()

            match = match_type(replay=prefix, move_getter=choose)
            try:
                match.play()
            except AtRoot:
                pass
            if not compared:
                counts['override_not_reproduced'] += 1
                continue
            state, direct, selected = compared
            try:
                lines = [play_line(match_type, prefix, state, line.moves, policy.predict, encoder)
                         for line in (direct, selected)]
            except IncompletePair as error:
                counts[str(error)] += 1
                continue
            ((a, aw, av), (b, bw, bv)) = lines
            if np.array_equal(a, b):
                counts['same_encoding'] += 1
                continue
            if on_pair is not None:
                on_pair(prefix, state, direct, selected, lines)
            rows.append((a, b, aw, bw, av, bv, number))
            found += 1
            if found == setup['pairs_per_round']:
                break
    return rows, counts


def worker(manifest_path, jobs_path):
    setup = read(manifest_path)
    batch = Path(setup['batch'])
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match

    seed_all(setup['seed'], 1)
    policy = setup['challenger']
    frozen = load_structured(Path(policy['path']), policy['encoding']).requires_grad_(False)
    encoder = RoundEncoder(card_catalog(batch))
    predict_encoder = position_encoder(batch, policy['encoding'])
    evaluate = load_round_value(batch, setup['value_head'])
    fallback = StaticFallback(batch)
    player = MicroPlayer(frozen, predict_encoder, fallback, '', None, policy_rollouts=True)
    output = manifest_path.parent
    try:
        for job in read(jobs_path):
            number, source, index, split = job
            rows, counts = collect_board(Match, Path(source), index, player, evaluate, encoder, setup)
            if rows:
                a, b, aw, bw, av, bv, rounds = zip(*rows)
                file = output / 'pairs' / f'{number:04}.npz'
                np.savez_compressed(file, a=np.asarray(a, dtype=np.float16), b=np.asarray(b, dtype=np.float16),
                                    labels=np.stack((aw, bw, av, bv, rounds), axis=1))
            write_json(output / 'boards' / f'{number:04}.json',
                       {'pairs': len(rows), 'split': split, 'counts': dict(counts)})
    finally:
        fallback.close()


def evaluate_pairs(logits, labels):
    aw, bw, av, bv, _ = labels.T
    delta = logits[:, 1] - logits[:, 0]
    chosen = delta > 0
    win_diff, vp_diff = bw - aw, bv - av
    correct = lambda diff: int(((delta.sign() == diff.sign()) & (diff != 0)).sum())
    return {'pairs': len(labels), 'wins_if_chosen': int(torch.where(chosen, bw, aw).sum()),
            'mean_vp_if_chosen': torch.where(chosen, bv, av).float().mean().item(),
            'winner_correct': correct(win_diff), 'winner_differs': int((win_diff != 0).sum()),
            'vp_correct': correct(vp_diff), 'vp_differs': int((vp_diff != 0).sum())}


def fit(output, setup):
    data = {split: [] for split in ('train', 'validation', 'test')}
    counts = Counter()
    for path in sorted((output / 'boards').glob('*.json')):
        row = read(path)
        counts.update(row['counts'])
        if row['pairs']:
            with np.load(output / 'pairs' / f'{path.stem}.npz', allow_pickle=False) as saved:
                features = np.stack((saved['a'], saved['b']), axis=1)
                data[row['split']].append((features, saved['labels']))
    for split, rows in data.items():
        if not rows:
            raise ValueError(f'No complete continuation pairs in the {split} split')
        data[split] = tuple(torch.from_numpy(np.concatenate(arrays)) for arrays in zip(*rows))
    seed_all(setup['seed'], 4)
    prior = torch.load(setup['value_head']['path'], weights_only=True, map_location='cpu')
    model = scorer(prior['input_size'])
    model.load_state_dict(prior['parameters'])
    model.eval()
    with torch.no_grad():
        original = {split: model(features.float()).squeeze(-1) for split, (features, _) in data.items()}
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4, weight_decay=.001)
    pair_loss = nn.BCEWithLogitsLoss()
    rng = torch.Generator().manual_seed(setup['seed'])

    def targets(labels):
        aw, bw, av, bv, _ = labels.T
        return torch.where(aw != bw, .5 + .45 * (bw - aw), .5 + .4 * ((bv - av) / 6).tanh())

    train_x, train_y = data['train']
    validation_x, validation_y = data['validation']
    train_y, validation_y = targets(train_y), targets(validation_y)
    best, history = None, []
    for epoch in range(1, setup['epochs'] + 1):
        model.eval()  # Compare paired scores without independent dropout noise.
        for chunk in torch.randperm(len(train_x), generator=rng).split(128):
            optimizer.zero_grad()
            logits = model(train_x[chunk].float()).squeeze(-1)
            shift = (logits - original['train'][chunk]).square().mean()
            loss = pair_loss(logits[:, 1] - logits[:, 0], train_y[chunk]) + .03 * shift
            loss.backward()
            optimizer.step()
        with torch.no_grad():
            logits = model(validation_x.float()).squeeze(-1)
            loss = pair_loss(logits[:, 1] - logits[:, 0], validation_y).item()
        if not history or loss < min(history):
            best = {key: value.clone() for key, value in model.state_dict().items()}
        history.append(loss)
        emit({'epoch': epoch, 'validation_pair_loss': loss})
    model.load_state_dict(best)
    torch.save({**prior, 'parameters': best}, output / 'round-value.pt')
    with torch.no_grad():
        metrics = {split: {'original': evaluate_pairs(original[split], labels),
                           'tuned': evaluate_pairs(model(features.float()).squeeze(-1), labels)}
                   for split, (features, labels) in data.items()}
    result = {'best_epoch': history.index(min(history)) + 1, 'validation_loss': history,
              'metrics': metrics, 'collection_counts': dict(counts)}
    write_json(output / 'results.json', result)
    emit(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pairs-per-round', type=int, default=3)
    parser.add_argument('--epochs', type=int, default=6)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--seed', type=int, default=201149)
    args = parser.parse_args()
    if min(args.pairs_per_round, args.epochs, args.workers) < 1:
        parser.error('Training limits must be positive')
    output = args.output.resolve()
    source = [path.resolve() for path in args.source]
    original = read(source[0] / 'manifest.json')
    setup = {key: original[key] for key in ('batch', 'challenger', 'rule_mix', 'search', 'value_head')}
    boards = []
    for path in source:
        manifest = read(path / 'manifest.json')
        if not manifest.get('round_rollouts') or any(manifest[key] != value for key, value in setup.items()):
            raise ValueError('Pair sources have different search settings or checkpoints')
        boards.extend((seed, str(path), index) for index, seed in enumerate(manifest['boards']))
    if len({seed for seed, _, _ in boards}) != len(boards) or len(boards) < 12:
        raise ValueError('Need unique boards for disjoint training, validation and test splits')
    for key in ('challenger', 'value_head'):
        if digest(Path(setup[key]['path'])) != setup[key]['sha256']:
            raise ValueError('Frozen source checkpoint changed')
    Random(args.seed).shuffle(boards)
    holdout = max(2, len(boards) // 8)
    jobs = [(number, path, index, 'test' if number < holdout else
             'validation' if number < 2 * holdout else 'train') for number, (_, path, index) in enumerate(boards)]
    for subdir in ('boards', 'pairs'):
        (output / subdir).mkdir(parents=True)
    setup.update(seed=args.seed, epochs=args.epochs, pairs_per_round=args.pairs_per_round,
                 board_seeds=[seed for seed, _, _ in boards], jobs=jobs, schema=SCHEMA)
    write_json(output / 'manifest.json', setup)
    emit({'stage': 'collecting paired continuations', 'boards': len(boards)})
    run_wave(output / 'manifest.json', jobs, args.workers, 0, worker_script=__file__)
    fit(output, setup)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
