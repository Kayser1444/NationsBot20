"""Train offline value heads on a frozen policy and evaluate saved counterfactual pairs."""
import argparse
from collections import Counter
from pathlib import Path
from random import Random
from statistics import mean
import sys

import numpy as np
import torch
from torch import nn

from audit_policy_reading import committed_prompts
from compare_position_checkpoints import read, run_wave
from compare_position_encoding import StaticFallback, load_structured, position_encoder
from compare_reading_continuations import observation
from mixed_rules import RULE_MIX, rules_for_board
from rescore_reading_handoffs import handoff, sign
from train import ROOT, board_seed, digest, emit, play_game, seed_all, write_json


FEATURES = ('self_acts_next', 'rival_acts_next', 'round_resolution_next',
            'new_turn_pending', 'self_main_actions_left', 'rival_main_actions_left')
HEADS = ('retrained_control', 'turn_aware')
TURN_VARIANTS = {'retrained_control': (), 'turn_aware': FEATURES}
HANDOFF_FEATURES = ('round_resolution_next',)


def turn_features(state, owner, next_player, counts, *, starts_turn=False):
    rival = next(player for player in state['players'] if player != owner)
    return [float(next_player == owner), float(next_player == rival), float(next_player is None),
            float(starts_turn), counts[owner] / 4, counts[rival] / 4]


@torch.inference_mode()
def board_embedding(encoder, model, state, owner):
    from nations_microsearch import handoff_observation

    numbers, tokens = encoder.state(handoff_observation(state, owner))
    pool = model.pool(model.state_embedding, torch.from_numpy(tokens).long().unsqueeze(0))
    return model.context(torch.cat((torch.from_numpy(numbers).unsqueeze(0), pool), -1))[0].numpy()


def record_game(match_type, encoder, model, fallback, seed, rules, sample_seed):
    rows = []
    rng = Random(sample_seed)

    def capture(match, next_player, stage, state=None):
        players = match.players
        state = observation(match) if state is None else state
        counts = {p.name: p.remaining_main_actions for p in players}
        for player in players:
            owner = player.name
            rows.append((owner, board_embedding(encoder, model, state, owner),
                         turn_features(state, owner, next_player, counts, starts_turn=stage == 1), stage))

    class RecordingMatch(match_type):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            for player in self.players:
                player.take_turn = self.record_turn(player, player.take_turn)

        def action_phase(self):
            self.last_turn = None
            return super().action_phase()

        def record_turn(self, player, take_turn):
            def turn():
                if self.last_turn not in (None, player.name) and rng.randrange(3) == 0:
                    capture(self, player.name, 1)
                self.last_turn = player.name
                return take_turn()
            return turn

        def production_phase(self):
            capture(self, None, 2)
            return super().production_phase()

    def capture_prompt(match, state, _options):
        if (match.phase.name == 'ACTION' and state['next_move_choice'] == 'Which action?'
                and rng.randrange(8) == 0):
            capture(match, state['next_move_player'], 0, state)

    players = {'Seat0': model, 'Seat1': model}
    game, _ = play_game(RecordingMatch, encoder, fallback, players, (), seed, None, sample=False,
                        sampling_seed=0, seconds=60, move_override=capture_prompt, rules=rules)
    if game['error']:
        return game['error'], []
    return None, [(board, features, stage, game['rewards'][owner]) for owner, board, features, stage in rows]


def heldout_pair(match_type, encoder, model, source, index, trace):
    sample = read(source / 'boards' / f'{index:04}.json')['sample']
    result = []
    for label in ('direct', 'top_two'):
        line = sample[label]
        replay = (source / 'replays' / line['replay']).read_text(encoding='utf-8')
        prompts, scores = committed_prompts(match_type, replay, observation)
        if scores != line['scores']:
            raise ValueError('Held-out rollout does not reproduce its final score')
        by_number = {state['move_number']: (state, prefix, move) for state, prefix, move in prompts}
        _, position, _ = handoff(by_number, sample, line, trace)
        state, owner = position.state, sample['actor']
        next_player = state['handoff_next_player']
        features = turn_features(state, owner, next_player, state['remaining_main_actions'],
                                 starts_turn=next_player is not None)
        result.append({'board': board_embedding(encoder, model, state, owner).tolist(),
                       'turn': features, 'won': line['won'], 'margin': line['margin'],
                       'boundary': position.boundary, 'root_move': sample['move_number']})
    if result[0]['boundary'] != result[1]['boundary']:
        raise ValueError('Held-out lines reached different kinds of handoff')
    return result


def worker(manifest_path, jobs_path):
    setup = read(manifest_path)
    batch = Path(setup['batch'])
    output = manifest_path.parent
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from nations_microsearch import trace

    seed_all(setup['seed'], 1)
    encoder = position_encoder(batch, setup['encoding'])
    model = load_structured(Path(setup['challenger']['path']), setup['encoding']).requires_grad_(False)
    fallback = StaticFallback(batch)
    rows, failures = [], Counter()
    try:
        for job in read(jobs_path):
            if job < 0:
                index = -job - 1
                pair = heldout_pair(Match, encoder, model, Path(setup['source']), index, trace)
                write_json(output / 'pairs' / f'{index:04}.json', pair)
                continue
            seed = board_seed('handoff-value-training-v1', setup['seed'], job)
            error, additions = record_game(Match, encoder, model, fallback, seed,
                                           rules_for_board(setup['seed'], job), setup['seed'] + job)
            if error:
                failures[error] += 1
            else:
                rows.extend((job, *item) for item in additions)
        game, board, turn, stage, won = zip(*rows)
        np.savez(jobs_path.with_suffix('.npz'), game=np.asarray(game), board=np.asarray(board),
                 turn=np.asarray(turn, dtype=np.float32), stage=np.asarray(stage),
                 won=np.asarray(won, dtype=np.float32))
        write_json(jobs_path.with_suffix('.counts.json'),
                   {'games': len(set(game)), 'examples': len(rows), 'failures': dict(failures)})
    finally:
        fallback.close()


def initialize_head(model, extra):
    old = model.value
    first = nn.Linear(old[0].in_features + extra, old[0].out_features)
    head = nn.Sequential(first, nn.Tanh(), nn.Linear(old[2].in_features, 1))
    with torch.no_grad():
        first.weight.zero_()
        first.weight[:, :old[0].in_features] = old[0].weight
        first.bias.copy_(old[0].bias)
        head[2].load_state_dict(old[2].state_dict())
    return head


def load_search_value(encoder, policy, policy_hash, checkpoint, *, handoff_only=False):
    path = Path(checkpoint['path'])
    if digest(path) != checkpoint['sha256']:
        raise ValueError('Search value head differs from the archived checkpoint')
    saved = torch.load(path, weights_only=True, map_location='cpu')
    features = tuple(saved['turn_features'])
    allowed = (HANDOFF_FEATURES,) if handoff_only else ((), FEATURES)
    if saved['policy_sha256'] != policy_hash or features not in allowed:
        raise ValueError('Search value head uses a different policy or turn schema')
    head = initialize_head(policy, len(features))
    head.load_state_dict(saved['parameters'])
    head.eval()

    @torch.inference_mode()
    def score(state, owner, next_player, counts, *, starts_turn=False):
        if handoff_only and (counts[owner] != 0 or next_player == owner):
            raise ValueError('The handoff-only head requires a fully spent turn')
        board = torch.from_numpy(board_embedding(encoder, policy, state, owner))
        if features:
            context = ([float(next_player is None)] if handoff_only else
                       turn_features(state, owner, next_player, counts, starts_turn=starts_turn))
            board = torch.cat((board, torch.tensor(context, dtype=board.dtype)))
        return head(board).sigmoid().item()

    return score


def fit(model, data, train, validation, seed, epochs, variants=TURN_VARIANTS):
    trained, results = {}, {}
    labels = data['won']
    loss_fn = nn.BCEWithLogitsLoss()
    for name, features in variants.items():
        indices = [FEATURES.index(feature) for feature in features]
        inputs = torch.cat((data['board'], data['turn'][:, indices]), -1)
        head = initialize_head(model, len(features))
        optimizer = torch.optim.Adam(head.parameters(), lr=.001)
        generator = torch.Generator().manual_seed(seed)
        best_loss, best, history = float('inf'), None, []
        for epoch in range(1, epochs + 1):
            for chunk in train[torch.randperm(len(train), generator=generator)].split(512):
                loss = loss_fn(head(inputs[chunk]).squeeze(-1), labels[chunk])
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()
            with torch.no_grad():
                loss = loss_fn(head(inputs[validation]).squeeze(-1), labels[validation]).item()
            history.append(loss)
            if loss < best_loss:
                best_loss = loss
                best = {k: v.detach().clone() for k, v in head.state_dict().items()}
        head.load_state_dict(best)
        trained[name] = head.eval()
        results[name] = {'validation_bce': best_loss, 'selected_epoch': history.index(best_loss) + 1,
                         'validation_bce_by_epoch': history}
    return trained, results


def score_pairs(model, heads, pairs, variants=TURN_VARIANTS):
    rows = [line for pair in pairs for line in pair]
    board = torch.tensor([row['board'] for row in rows])
    context = torch.tensor([row['turn'] for row in rows])
    predictions = {'frozen_100k': model.value(board)}
    for name, features in variants.items():
        indices = [FEATURES.index(feature) for feature in features]
        predictions[name] = heads[name](torch.cat((board, context[:, indices]), -1))
    for name, values in predictions.items():
        for row, score in zip(rows, values.sigmoid().flatten().tolist()):
            row[name] = score


def metrics(pairs, name):
    rows = [line for pair in pairs for line in pair]
    choices = [b if sign(b[name] - a[name]) > 0 else a for a, b in pairs]
    result = {'brier': mean((row[name] - row['won']) ** 2 for row in rows),
              'wins_if_following_score': sum(row['won'] for row in choices),
              'mean_vp_if_following_score': mean(row['margin'] for row in choices)}
    for key in ('won', 'margin'):
        signs = [(sign(b[name] - a[name]), sign(b[key] - a[key])) for a, b in pairs if b[key] != a[key]]
        result[key] = {'correct': sum(p == q for p, q in signs), 'wrong': sum(p == -q for p, q in signs),
                       'tied': sum(p == 0 for p, _ in signs), 'different_outcomes': len(signs)}
    return result


def ranking_change(pairs, before, after, key):
    changes = []
    for a, b in pairs:
        if a[key] != b[key]:
            target = sign(b[key] - a[key])
            changes.append(int(sign(b[after] - a[after]) == target) - int(sign(b[before] - a[before]) == target))
    if not changes:
        return {'estimate': None, 'paired_95': None}
    rng = Random(197)
    draws = sorted(mean(rng.choices(changes, k=len(changes))) for _ in range(4000))
    return {'estimate': mean(changes), 'paired_95': [draws[100], draws[3899]]}


def load_training_data(output):
    columns = ('game', 'board', 'turn', 'stage', 'won')
    shards = []
    for path in sorted(output.glob('wave-00-worker-*.npz')):
        with np.load(path, allow_pickle=False) as saved:
            shards.append({key: saved[key] for key in columns})
    return {key: torch.from_numpy(np.concatenate([s[key] for s in shards])) for key in columns}


def train_handoff_only(archive_path, output, epochs):
    archive = read(archive_path / 'manifest.json')
    policy = Path(archive['challenger']['path'])
    policy_hash = digest(policy)
    if (policy_hash != archive['challenger']['sha256'] or tuple(archive['turn_features']) != FEATURES
            or not (archive_path / 'results.json').is_file()):
        raise ValueError('Expected the completed turn-aware training archive and its frozen policy')
    data = load_training_data(archive_path)
    self_next, _, _, _, self_left, _ = data['turn'].T
    eligible = (data['stage'] != 0) & (self_next == 0) & (self_left == 0)
    train = (eligible & (data['game'] < archive['requested_games'])).nonzero().flatten()
    validation = (eligible & (data['game'] >= archive['requested_games'])).nonzero().flatten()
    pairs = [read(archive_path / 'pairs' / f'{index:04}.json') for index in range(archive['boards'])]
    pairs = [pair for pair in pairs if all(row['turn'][0] == row['turn'][4] == 0 for row in pair)]
    output.mkdir(parents=True)
    write_json(output / 'manifest.json', {**archive, 'training_archive': str(archive_path),
                                         'epochs': epochs, 'turn_features': HANDOFF_FEATURES})
    training = {'games': int(data['game'][train].unique().numel()), 'examples': len(train),
                'validation_games': int(data['game'][validation].unique().numel()),
                'validation_handoffs': len(validation)}
    emit({'stage': 'fitting', **training})
    seed_all(archive['seed'], 4)
    model = load_structured(policy, archive['encoding']).requires_grad_(False)
    variants = {'handoff_only': HANDOFF_FEATURES}
    heads, fit_report = fit(model, data, train, validation, archive['seed'], epochs, variants)
    with torch.inference_mode():
        score_pairs(model, heads, pairs, variants)
    torch.save({'policy_sha256': policy_hash, 'encoding': archive['encoding'],
                'turn_features': HANDOFF_FEATURES, 'parameters': heads['handoff_only'].state_dict()},
               output / 'handoff-value.pt')
    report = {'training': training, 'fit': fit_report, 'held_out_pairs': len(pairs),
              'results': {name: metrics(pairs, name) for name in ('frozen_100k', *variants)},
              'ranking_change': {key: ranking_change(pairs, 'frozen_100k', 'handoff_only', key)
                                 for key in ('won', 'margin')}}
    write_json(output / 'results.json', report)
    emit(report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument('--source', type=Path)
    sources.add_argument('--handoff-data', type=Path,
                         help='Refit using only spent-turn rows from the completed turn-aware run.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--games', type=int, default=3000)
    parser.add_argument('--validation-games', type=int, default=300)
    parser.add_argument('--epochs', type=int, default=12)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--seed', type=int, default=181180)
    args = parser.parse_args()
    if args.epochs < 1:
        parser.error('--epochs must be positive')
    if args.handoff_data is not None:
        return train_handoff_only(args.handoff_data.resolve(), args.output.resolve(), args.epochs)
    source, output = args.source.resolve(), args.output.resolve()
    archive = read(source / 'manifest.json')
    policy = Path(archive['challenger']['path'])
    if digest(policy) != archive['challenger']['sha256'] or archive['rule_mix'] != RULE_MIX:
        raise ValueError('Checkpoint or rule settings differ from the saved audit')
    (output / 'pairs').mkdir(parents=True)
    setup = {**archive, 'source': str(source), 'seed': args.seed, 'requested_games': args.games,
             'validation_games': args.validation_games, 'epochs': args.epochs, 'turn_features': FEATURES}
    manifest = output / 'manifest.json'
    write_json(manifest, setup)
    game_ids = list(range(args.games + args.validation_games))
    audit_seeds = {read(path)['seed'] for path in (source / 'boards').glob('*.json')}
    if audit_seeds & {board_seed('handoff-value-training-v1', args.seed, i) for i in game_ids}:
        raise ValueError('Training and held-out boards overlap')
    jobs = [-i - 1 for i in range(archive['boards'])] + game_ids
    emit({'stage': 'collecting', 'games': len(game_ids), 'held_out_pairs': archive['boards']})
    run_wave(manifest, jobs, args.workers, 0, worker_script=__file__)
    data = load_training_data(output)
    train = (data['game'] < args.games).nonzero().flatten()
    validation = ((data['game'] >= args.games) & (data['stage'] != 0)).nonzero().flatten()
    training = {'games': int(data['game'][train].unique().numel()), 'examples': len(train),
                'validation_games': int(data['game'][validation].unique().numel()),
                'validation_handoffs': len(validation)}
    failures = Counter()
    for path in output.glob('*.counts.json'):
        failures.update(read(path)['failures'])
    training['failures'] = dict(failures)
    emit({'stage': 'fitting', **training})
    seed_all(args.seed, 4)
    model = load_structured(policy, archive['encoding']).requires_grad_(False)
    heads, fit_report = fit(model, data, train, validation, args.seed, args.epochs)
    pairs = [read(output / 'pairs' / f'{i:04}.json') for i in range(archive['boards'])]
    with torch.inference_mode():
        score_pairs(model, heads, pairs)
    for name, filename in (('turn_aware', 'turn-aware-value.pt'), ('retrained_control', 'control-value.pt')):
        torch.save({'policy_sha256': digest(policy), 'encoding': archive['encoding'],
                    'turn_features': FEATURES if name == 'turn_aware' else (),
                    'parameters': heads[name].state_dict()}, output / filename)
    report = {'training': training, 'fit': fit_report, 'held_out_pairs': len(pairs),
              'results': {name: metrics(pairs, name) for name in ('frozen_100k', *HEADS)},
              'ranking_change': {base: {key: ranking_change(pairs, base, 'turn_aware', key)
                                        for key in ('won', 'margin')} for base in ('frozen_100k', 'retrained_control')}}
    write_json(output / 'scored-pairs.json', [{name: {k:v for k,v in row.items() if k != 'board'}
                                               for name,row in zip(('direct','top_two'),pair)} for pair in pairs])
    write_json(output / 'results.json', report)
    emit(report)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
