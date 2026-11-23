"""Fit a standalone win scorer on complete round and age settlements."""
import argparse
from collections import Counter
from math import tanh
from pathlib import Path
from random import Random
import sys

import numpy as np
import torch
from torch import nn

from compare_position_checkpoints import read, run_wave
from compare_position_encoding import StaticFallback, card_catalog, load_structured, position_encoder
from compare_position_microsearch import MicroPlayer
from audit_policy_reading import committed_prompts
from model import collate
from mixed_encoding import MixedSettingsEncoder
from mixed_rules import RULE_MIX, rules_for_board
from train import ROOT, board_seed, digest, emit, play_game, seed_all, write_json


SCHEMA_V1 = 'settled-round-value-v1'
SCHEMA = 'settled-round-value-v2'


def round_observation(match):
    return {**match.get_state(), 'weighted_card_draw': match.weighted_card_draw,
            'resource_tiebreak': match.resource_remainder_tiebreaker,
            'growth_allowances': {player.name: player.growth_resources for player in match.players}}


class RoundEncoderV1(MixedSettingsEncoder):
    def settled(self, state, owner):
        normalized, _, _ = self.observation({**state, 'next_move_player': owner, 'next_move_choice': '',
                                             'next_move_options': ()})
        names = [owner, next(name for name in state['players'] if name != owner)]
        features = [state['round'] / 8, float(state['player_order'][0] == owner),
                    float(state['resource_tiebreak']), float(state['weighted_card_draw'])]
        for name in names:
            player = normalized['players'][name]
            numbers = self.player_numbers({**player, 'passed': 0})
            features.extend(numbers)
            features.extend((state['growth_allowances'][name] / 4, player['resource_remainder'] / 10,
                             len([card for card in player['dynasties'] if card]) / 4))
            features.extend(self.player_profile(player))
            features.extend(self.player_abilities(player))
        return np.asarray(features, dtype=np.float32)


class RoundEncoder(MixedSettingsEncoder):
    def player_profile(self, player):
        # Resources are always present, and books already occur in player_numbers.
        return super().player_profile(player)[2:]

    def settled(self, state, owner):
        # Reuse physical card and ability features, with normalized wonder slots.
        normalized, _, _ = self.observation({**state, 'next_move_player': owner, 'next_move_choice': '',
                                             'next_move_options': ()})
        names = [owner, next(name for name in state['players'] if name != owner)]
        features = [state['round'] / 8, float(state['player_order'][0] == owner),
                    float(state['resource_tiebreak']), float(state['weighted_card_draw'])]
        for name in names:
            player = normalized['players'][name]
            # Pass and pass order expire at the next maintenance phase.
            numbers = self.player_numbers({**player, 'passed': 0})
            features.extend(numbers)
            features.extend((state['growth_allowances'][name] / 4, player['resource_remainder'] / 10,
                             len([card for card in player['dynasties'] if card]) / 4))
            features.extend(self.player_profile(player))
            features.extend(self.player_abilities(player))
        if state['round'] < 8:
            next_market = {card for slot, card in state['progress_board'].items()
                           if slot.startswith('P3')}
            features.extend(float(card in next_market) for card in sorted(self.cards))
        else:
            features.extend(0. for _ in self.cards)
        return np.asarray(features, dtype=np.float32)


def scorer(input_size):
    return nn.Sequential(nn.Linear(input_size, 96), nn.LayerNorm(96), nn.GELU(), nn.Dropout(.10),
                         nn.Linear(96, 32), nn.GELU(), nn.Linear(32, 1))


def round_encoder_for(cards, schema):
    if schema == SCHEMA_V1:
        return RoundEncoderV1(cards)
    if schema == SCHEMA:
        return RoundEncoder(cards)
    raise ValueError('Unexpected settled-round value schema')


def load_round_value(batch, checkpoint):
    path = Path(checkpoint['path'])
    if digest(path) != checkpoint['sha256']:
        raise ValueError('Round scorer differs from the archived checkpoint')
    saved = torch.load(path, weights_only=True, map_location='cpu')
    encoder = round_encoder_for(card_catalog(batch), saved['schema'])
    model = scorer(saved['input_size'])
    model.load_state_dict(saved['parameters'])
    model.eval()

    @torch.inference_mode()
    def evaluate(state, owner):
        if state['round'] == 8:
            # Engine scoring breaks any remaining tie in current player order.
            order = state['player_order']
            own, rival = state['players'][owner], state['players'][next(name for name in order if name != owner)]
            margin = state['final_margin']
            remainder = own['resource_remainder'] - rival['resource_remainder'] if state['resource_tiebreak'] else 0
            return state['final_winner'] == owner, margin, remainder
        return model(torch.from_numpy(encoder.settled(state, owner))).sigmoid().item(),

    return evaluate


def worker(manifest_path, jobs_path):
    setup = read(manifest_path)
    batch = Path(setup['batch'])
    sys.path.insert(0, str(batch / 'snapshot/engine'))
    from nations import Match
    from nations_microsearch import ADMIN, MAIN
    from nations_move_safety import safe_architect_options, with_move_options
    from nations.exceptions import GameOver

    seed_all(setup['seed'], 1)
    policy = load_structured(Path(setup['policy']['path']), setup['policy']['encoding']).requires_grad_(False)
    policy_encoder = position_encoder(batch, setup['policy']['encoding'])
    encoder = RoundEncoder(card_catalog(batch))
    fallback = StaticFallback(batch)
    boards, positions, rounds, labels = [], [], [], []
    pair_boards, pair_direct, pair_branch, pair_labels = [], [], [], []
    failures = Counter()
    examples = []
    branch_counts = Counter()

    class RecordingMatch(Match):
        def resolution_phase(self):
            super().resolution_phase()
            state = round_observation(self)
            for owner in state['players']:
                examples.append((owner, self.round_number, encoder.settled(state, owner)))

    try:
        for index in read(jobs_path):
            examples.clear()
            replay_path = manifest_path.parent / 'replays' / f'{index:05}.replay'
            row, _ = play_game(RecordingMatch, policy_encoder, fallback, {'Seat0': policy, 'Seat1': policy}, (),
                               board_seed(SCHEMA, setup['seed'], index), replay_path, sample=False, sampling_seed=0,
                               seconds=60, rules=rules_for_board(setup['seed'], index))
            if row['error']:
                failures[row['error']] += 1
                continue
            if len(examples) != 14:
                raise ValueError('A complete game must yield both perspectives on rounds 1 through 7')
            direct_examples = {(owner, number): features for owner, number, features in examples}
            for owner, number, features in examples:
                boards.append(index)
                positions.append(features.astype(np.float16))
                rounds.append(number)
                labels.append(row['rewards'][owner])

            def observed(match):
                state = round_observation(match)
                options = safe_architect_options(match, state['next_move_choice'], match.next_move_options)
                return with_move_options(state, options)

            prompts, _ = committed_prompts(Match, replay_path.read_text(encoding='utf-8'), observed)
            candidates = []
            for state, prefix, played in prompts:
                if (state['round'] > 7 or state['next_move_choice'] != MAIN
                        or state['next_move_player'] not in ('Seat0', 'Seat1')):
                    continue
                legal = tuple(move for move in state['next_move_options'] if move not in ADMIN)
                if len(legal) < 2 or not policy_encoder.supports(state):
                    continue
                features, moves = policy_encoder.encode(state)
                with torch.inference_mode():
                    logits, _ = policy(collate([features]))
                ranked = sorted(range(len(moves)), key=logits[0].tolist().__getitem__, reverse=True)
                if len(ranked) < 2 or moves[0] != played:
                    continue
                candidates.append((state, prefix, moves[ranked[1]]))
            if not candidates:
                branch_counts['no runner-up position'] += 1
                continue

            selected_root = Random(f'{setup["seed"]}/{index}/counterfactual').choice(candidates)
            root, prefix, alternate = selected_root
            branch_settlements = []

            class CounterfactualMatch(Match):
                def resolution_phase(self):
                    super().resolution_phase()
                    if self.round_number == root['round']:
                        branch_settlements.append(round_observation(self))

            def choose(prompt, options, _undo):
                if branch_match.invalid_move:
                    raise RuntimeError('Counterfactual replay encountered an invalid move')
                options = safe_architect_options(branch_match, prompt, options)
                legal = {str(option): option for option in options if str(option) not in ADMIN}
                if not legal:
                    raise RuntimeError('Counterfactual replay has no legal move')
                for confirmation in ('Confirm',):
                    if confirmation in legal:
                        return legal[confirmation]
                if len(legal) == 1:
                    return next(iter(legal.values()))
                state = with_move_options(round_observation(branch_match), options)
                if state['move_number'] == root['move_number']:
                    if state != root:
                        raise ValueError('Counterfactual replay did not reproduce its root')
                    move = alternate
                elif policy_encoder.supports(state):
                    features, moves = policy_encoder.encode(state)
                    with torch.inference_mode():
                        logits, _ = policy(collate([features]))
                    move = moves[int(logits[0].argmax())]
                else:
                    move = fallback.choose(state)
                if move not in legal:
                    raise ValueError(f'Counterfactual policy chose unavailable move {move!r}')
                return legal[move]

            branch_match = CounterfactualMatch(replay=prefix, move_getter=choose)
            try:
                branch_match.play()
            except GameOver:
                pass
            if not branch_match.game_over or len(branch_settlements) != 1:
                branch_counts['incomplete counterfactual'] += 1
                continue
            branch_scores = {player.name: player.score() for player in branch_match.players}
            branch_order = sorted(branch_match.players, key=lambda player: (
                -branch_scores[player.name],
                -player.resource_remainder() if branch_match.resource_remainder_tiebreaker else 0))
            branch_rewards = {player.name: float(player is branch_order[0]) for player in branch_match.players}
            branch_state = branch_settlements[0]
            branch_features = {owner: encoder.settled(branch_state, owner) for owner in branch_state['players']}
            for owner in branch_state['players']:
                boards.append(index)
                positions.append(branch_features[owner].astype(np.float16))
                rounds.append(root['round'])
                labels.append(branch_rewards[owner])
                direct_value = row['rewards'][owner]
                direct_margin = (row['scores'][owner] - row['scores'][next(name for name in row['scores'] if name != owner)])
                branch_margin = (branch_scores[owner] - branch_scores[next(name for name in branch_scores if name != owner)])
                if direct_value != branch_rewards[owner]:
                    preference = .5 + .45 * (branch_rewards[owner] - direct_value)
                else:
                    preference = .5 + .4 * tanh((branch_margin - direct_margin) / 6)
                pair_boards.append(index)
                pair_direct.append(direct_examples[(owner, root['round'])].astype(np.float16))
                pair_branch.append(branch_features[owner].astype(np.float16))
                pair_labels.append(preference)
            branch_counts['paired counterfactuals'] += 1
        np.savez(jobs_path.with_suffix('.npz'), board=boards, position=positions, round=rounds, won=labels)
        np.savez_compressed(jobs_path.with_suffix('.pairs.npz'), board=pair_boards, direct=pair_direct,
                            branch=pair_branch, preference=pair_labels)
        write_json(jobs_path.with_suffix('.counts.json'), dict(failures + branch_counts))
    finally:
        fallback.close()


def fit(output, setup):
    data = {key: [] for key in ('board', 'position', 'round', 'won')}
    for path in sorted(output.glob('wave-00-worker-??.npz')):
        with np.load(path, allow_pickle=False) as saved:
            for key in data:
                data[key].append(saved[key])
    data = {key: torch.from_numpy(np.concatenate(values)) for key, values in data.items()}
    pair_data = {key: [] for key in ('board', 'direct', 'branch', 'preference')}
    for path in sorted(output.glob('wave-00-worker-*.pairs.npz')):
        with np.load(path, allow_pickle=False) as saved:
            for key in pair_data:
                pair_data[key].append(saved[key])
    pair_data = {key: torch.from_numpy(np.concatenate(values)) for key, values in pair_data.items()}
    train = (data['board'] < setup['games']).nonzero().flatten()
    validation = (data['board'] >= setup['games']).nonzero().flatten()
    train_pairs = (pair_data['board'] < setup['games']).nonzero().flatten()
    validation_pairs = (pair_data['board'] >= setup['games']).nonzero().flatten()
    seed_all(setup['seed'], 4)
    model = scorer(data['position'].shape[1])
    optimizer = torch.optim.AdamW(model.parameters(), lr=.001, weight_decay=.001)
    loss_fn = nn.BCEWithLogitsLoss()
    rng = torch.Generator().manual_seed(setup['seed'])
    best, history = None, []
    emit({'stage': 'fitting', 'train_examples': len(train), 'validation_examples': len(validation),
          'train_pairs': len(train_pairs), 'validation_pairs': len(validation_pairs)})
    for epoch in range(1, setup['epochs'] + 1):
        model.train()
        for chunk in train[torch.randperm(len(train), generator=rng)].split(512):
            optimizer.zero_grad()
            loss = loss_fn(model(data['position'][chunk].float()).flatten(), data['won'][chunk].float())
            loss.backward()
            optimizer.step()
        for chunk in train_pairs[torch.randperm(len(train_pairs), generator=rng)].split(128):
            direct_logits = model(pair_data['direct'][chunk].float()).flatten()
            branch_logits = model(pair_data['branch'][chunk].float()).flatten()
            loss = nn.functional.binary_cross_entropy_with_logits(
                branch_logits - direct_logits, pair_data['preference'][chunk].float())
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        model.eval()
        with torch.inference_mode():
            logits = model(data['position'][validation].float()).flatten()
            loss = loss_fn(logits, data['won'][validation].float()).item()
        if not history or loss < min(history):
            best = {key: value.clone() for key, value in model.state_dict().items()}
        history.append(loss)
        emit({'epoch': epoch, 'validation_bce': loss})
    model.load_state_dict(best)
    with torch.inference_mode():
        probabilities = model(data['position'][validation].float()).flatten().sigmoid()
    torch.save({'schema': SCHEMA, 'input_size': data['position'].shape[1], 'parameters': best},
               output / 'round-value.pt')
    errors = (probabilities - data['won'][validation]).square()
    round_numbers = data['round'][validation]
    with torch.inference_mode():
        direct_logits = model(pair_data['direct'][validation_pairs].float()).flatten()
        branch_logits = model(pair_data['branch'][validation_pairs].float()).flatten()
        preference_predictions = (branch_logits - direct_logits).sigmoid()
    pair_errors = (preference_predictions - pair_data['preference'][validation_pairs].float()).square()
    collection_counts = Counter()
    for path in output.glob('*.counts.json'):
        collection_counts.update(read(path))
    pair_mask = pair_data['preference'][validation_pairs].float().ne(.5)
    pair_order_accuracy = (((preference_predictions >= .5)
                            == (pair_data['preference'][validation_pairs].float() >= .5))[pair_mask]
                           .float().mean().item())
    report = {'training_games': int(data['board'][train].unique().numel()), 'training_positions': len(train),
              'validation_games': int(data['board'][validation].unique().numel()),
              'validation_positions': len(validation),
              'counterfactual_games': collection_counts['paired counterfactuals'],
              'failures': {name: count for name, count in collection_counts.items()
                           if name != 'paired counterfactuals'},
              'best_epoch': history.index(min(history)) + 1, 'validation_bce': history,
              'validation_brier': errors.mean().item(),
              'validation_pair_count': len(validation_pairs),
              'validation_pair_brier': pair_errors.mean().item(),
              'validation_pair_order_accuracy': pair_order_accuracy,
              'validation_accuracy': (probabilities.ge(.5) == data['won'][validation].bool()).float().mean().item(),
              'brier_by_round': {n: errors[round_numbers == n].mean().item() for n in range(1, 8)}}
    write_json(output / 'results.json', report)
    emit(report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--games', type=int, default=6000)
    parser.add_argument('--validation-games', type=int, default=600)
    parser.add_argument('--epochs', type=int, default=12)
    parser.add_argument('--workers', type=int, default=6)
    args = parser.parse_args()
    if min(args.games, args.validation_games, args.epochs, args.workers) < 1:
        parser.error('Training, validation, epochs, and workers must be positive')
    reference = read(args.reference / 'manifest.json')
    policy = (reference.get('policy') or reference.get('challenger')
              or reference.get('checkpoints', {}).get('100000'))
    if policy is None:
        raise ValueError('Reference manifest has no frozen 100K policy checkpoint')
    if digest(Path(policy['path'])) != policy['sha256'] or reference['rule_mix'] != RULE_MIX:
        raise ValueError('Frozen policy or mixed settings differ from the benchmark')
    output = args.output.resolve()
    output.mkdir(parents=True)
    (output / 'replays').mkdir()
    setup = {'batch': reference['batch'], 'policy': policy, 'rule_mix': RULE_MIX, 'seed': 201109,
             'games': args.games, 'validation_games': args.validation_games, 'epochs': args.epochs}
    manifest = output / 'manifest.json'
    write_json(manifest, setup)
    total = args.games + args.validation_games
    emit({'stage': 'collecting', 'games': total})
    run_wave(manifest, list(range(total)), args.workers, 0, worker_script=__file__)
    fit(output, setup)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
