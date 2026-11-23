"""Compare branch observations and model outputs with committed replay prompts."""
import argparse
from collections import Counter, deque
from pathlib import Path
import sys
from time import perf_counter

import numpy as np
import torch

from compare_position_checkpoints import read
from compare_position_encoding import load_structured, position_encoder
from model import collate
from train import ROOT, digest, emit, write_json


def committed_prompts(match_type, replay, observe=None):
    """Run the archived decisions through the ordinary live move callback."""
    prompts = []

    def choose(_prompt, options, _undo):
        legal = {str(option): option for option in options}
        move = remaining.popleft()
        state = match.get_state() if observe is None else observe(match)
        prompts.append((state, match.get_replay(), move))
        return legal[move]

    match = match_type(replay=replay, move_getter=choose)
    remaining = deque(match.move_list)
    match.move_list.clear()
    match.play()
    if remaining or match.get_replay() != replay:
        raise ValueError('Committed callback did not reproduce the complete archival replay')
    return prompts, {p.name: p.score() for p in match.players}


@torch.inference_mode()
def compare_inputs(encoder, model, simulated, committed):
    a, a_moves = encoder.encode(simulated)
    b, b_moves = encoder.encode(committed)
    inputs = [key for key in a if not np.array_equal(a[key], b[key])]
    if a_moves != b_moves:
        return inputs, ['ordering of legal moves']
    a_logits, a_value = model(collate([a]))
    b_logits, b_value = model(collate([b]))
    scores = []
    if not torch.equal(a_logits, b_logits):
        scores.append('policy logits')
    if not torch.equal(a_value, b_value):
        scores.append('value logit')
    return inputs, scores


def inspect_game(prompts, owner, encoder, model, max_depth, trace, admin):
    totals, depths = Counter(), Counter()
    differences = []
    for index, (root, replay, _) in enumerate(prompts):
        if (root['next_move_player'] != owner or root['next_move_choice'] != 'Which action?'
                or root['phase'] != 'Action Phase'):
            continue
        path = []
        for target_index in range(index + 1, len(prompts)):
            previous, _, move = prompts[target_index - 1]
            target = prompts[target_index][0]
            if target['next_move_player'] != owner or target['round'] != root['round']:
                break
            target_legal = set(target['next_move_options']) - admin
            previous_legal = set(previous['next_move_options']) - admin
            if not path or len(previous_legal) > 1:
                path.append(move)
            if len(path) > max_depth:
                break
            if len(target_legal) <= 1:
                continue  # Branch replay follows forced prompts internally.
            fork = trace(replay, root, tuple(path), perf_counter() + 5, pre_move=True)
            if fork.boundary:
                totals[f'stopped: {fork.boundary}'] += 1
                break
            diffs = [key for key in target if target[key] != fork.state.get(key)]
            inputs, scores = [], []
            if encoder.supports(target):
                inputs, scores = compare_inputs(encoder, model, fork.state, target)
                totals['model_prompts'] += 1
                depths[len(path)] += 1
            else:
                totals['other_prompts'] += 1
            totals['compared'] += 1
            totals['state_mismatches'] += bool(diffs)
            totals['input_mismatches'] += bool(inputs)
            totals['score_mismatches'] += bool(scores)
            if (diffs or inputs or scores) and len(differences) < 10:
                differences.append({'root_move_number': root['move_number'], 'path': list(path),
                                    'target_move_number': target['move_number'],
                                    'state_fields': diffs, 'inputs': inputs, 'scores': scores})
    return totals, depths, differences


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, action='append', required=True)
    parser.add_argument('--boards', type=int, default=6, help='Sample this many archived boards per variant.')
    parser.add_argument('--max-depth', type=int, default=8)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if min(args.boards, args.max_depth) < 1:
        parser.error('Board count and max depth must be positive')
    torch.set_num_threads(1)
    manifest = read(args.run[0] / 'manifest.json')
    batch = Path(manifest['batch'])
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from nations_microsearch import ADMIN, trace

    checkpoint = Path(manifest['challenger']['path'])
    if digest(checkpoint) != manifest['challenger']['sha256']:
        raise ValueError('The audit checkpoint differs from the archived benchmark')
    schema = manifest['encoding']
    encoder = position_encoder(batch, schema)
    model = load_structured(checkpoint, schema)
    report = {}
    for run in args.run:
        other = read(run / 'manifest.json')
        if any(other[key] != manifest[key] for key in ('batch', 'challenger', 'encoding', 'rules')):
            raise ValueError('All replay runs must share the same snapshot, rules, and checkpoint')
        totals, depths, cases = Counter(), Counter(), []
        boards = sorted((run / 'boards').glob('*.json'))[:args.boards]
        if len(boards) != args.boards:
            raise ValueError(f'Missing completed boards in {run}')
        for board in boards:
            for game in read(board)['games']:
                replay = (run / 'replays' / game['replay']).read_text(encoding='utf-8')
                prompts, scores = committed_prompts(Match, replay)
                if scores != game['scores']:
                    raise ValueError('Committed replay score differs from the archive')
                metrics, lengths, differences = inspect_game(
                    prompts, game['candidate'], encoder, model, args.max_depth, trace, ADMIN)
                totals.update(metrics)
                depths.update(lengths)
                cases.extend({'replay': game['replay'], **case} for case in differences)
        report[run.name] = {'games': 2 * len(boards), 'counts': dict(totals),
                            'scored_depths': dict(sorted(depths.items())), 'examples': cases[:10]}
    write_json(args.output, report)
    emit(report)


if __name__ == '__main__':
    main()
