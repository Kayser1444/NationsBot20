"""Score both saved continuation rollouts at fully resolved handoffs."""
import argparse
from collections import Counter
from pathlib import Path
from random import Random
from statistics import mean
import sys
from time import perf_counter

from audit_policy_reading import committed_prompts
from compare_position_checkpoints import read, run_wave
from compare_position_encoding import load_structured, position_encoder
from compare_position_microsearch import MicroPlayer
from compare_reading_continuations import observation
from train import ROOT, digest, emit, seed_all, write_json


def handoff(prompts, sample, line, trace):
    root, prefix, _ = prompts[sample['move_number']]
    if root['next_move_player'] != sample['actor'] or root['round'] != sample['round']:
        raise ValueError('Saved replay starts the line at a different position')
    path = list(line['moves'])
    deadline = perf_counter() + 15
    while perf_counter() < deadline:
        position = trace(prefix, root, tuple(path), deadline, pre_move=True, capture_handoff=True)
        if position.boundary:
            if position.boundary not in ('opponent turn', 'round resolution') or not position.state:
                raise ValueError(f'Line did not reach a fully resolved handoff: {position.boundary}')
            if line['boundary'] is not None and position.boundary != line['boundary']:
                raise ValueError('Saved line reaches a different handoff')
            return root, position, path
        if line['boundary'] is not None:
            raise ValueError('Saved complete line reached another decision')
        state = position.state
        committed, _, chosen = prompts[state['move_number']]
        if state != committed:
            raise ValueError('The saved cutoff continuation no longer matches its replay')
        path.append(chosen)
    raise ValueError('Saved cutoff continuation did not reach a handoff')


def worker(manifest_path, jobs_path):
    manifest = read(manifest_path)
    batch = Path(manifest['batch'])
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from nations_microsearch import handoff_observation, trace

    seed_all(manifest['seed'], 1)
    source, output = Path(manifest['source']), manifest_path.parent
    encoder = position_encoder(batch, manifest['encoding'])
    model = load_structured(Path(manifest['challenger']['path']), manifest['encoding'])
    scorer = MicroPlayer(model, encoder, None, '', None)
    for index in read(jobs_path):
        sample = read(source / 'boards' / f'{index:04}.json')['sample']
        result = {}
        for label in ('direct', 'top_two'):
            line = sample[label]
            replay = (source / 'replays' / line['replay']).read_text(encoding='utf-8')
            prompts, scores = committed_prompts(Match, replay, observation)
            if scores != line['scores']:
                raise ValueError('Saved rollout does not reproduce its final score')
            by_number = {state['move_number']: (state, prefix, move) for state, prefix, move in prompts}
            root, position, path = handoff(by_number, sample, line, trace)
            # Both lines use the original actor and identical prompt/menu features.
            state = handoff_observation(position.state, sample['actor'])
            value = scorer.predict(state)['winProbability']
            result[label] = {'value': value, 'pre_move_value': line['value'], 'won': line['won'],
                             'margin': line['margin'], 'boundary': position.boundary,
                             'moves': path, 'originally_complete': line['boundary'] is not None}
            if label == 'direct':
                direct_root = root
            elif root != direct_root:
                raise ValueError('The two lines did not start from the same observation')
        write_json(output / 'boards' / f'{index:04}.json', result)


def sign(value):
    return 0 if abs(value) < 1e-7 else 1 if value > 0 else -1


def evaluate(samples):
    win_changes = [b['won'] - a['won'] for a, b in samples]
    vp_changes = [b['margin'] - a['margin'] for a, b in samples]
    result = {'positions': len(samples), 'boundary_pairs': dict(Counter(
        f"{a['boundary']} / {b['boundary']}" for a, b in samples))}
    rankings = []
    for column in ('pre_move_value', 'value'):
        gaps = [b[column] - a[column] for a, b in samples]
        signs = [sign(gap) for gap in gaps]
        rankings.append(signs)
        selected = [b if direction > 0 else a for direction, (a, b) in zip(signs, samples)]
        row = {'prefers_top_two': signs.count(1), 'prefers_direct': signs.count(-1),
               'tied': signs.count(0), 'mean_win_estimate_gap': mean(gaps),
               'wins_if_following_score': sum(s['won'] for s in selected),
               'vp_margin_if_following_score': mean(s['margin'] for s in selected)}
        for metric, changes in (('win', win_changes), ('vp', vp_changes)):
            pairs = [(direction, sign(change)) for direction, change in zip(signs, changes) if change]
            row[f'{metric}_ranking'] = {'correct': sum(d == s for d, s in pairs),
                                       'wrong': sum(d == -s for d, s in pairs),
                                       'score_tied': sum(d == 0 for d, _ in pairs),
                                       'outcomes_differ': len(pairs)}
        result['before' if column == 'pre_move_value' else 'handoff'] = row
    for metric, changes in (('win', win_changes), ('vp', vp_changes)):
        improvements = [int(after == sign(change)) - int(before == sign(change))
                        for before, after, change in zip(*rankings, changes) if change]
        if improvements:
            rng = Random(198)
            draws = sorted(mean(rng.choices(improvements, k=len(improvements))) for _ in range(4000))
            result[f'{metric}_accuracy_change'] = {'estimate': mean(improvements),
                                                  'paired_95': [draws[100], draws[3899]]}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=6)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    archive = read(source / 'manifest.json')
    if digest(Path(archive['challenger']['path'])) != archive['challenger']['sha256']:
        raise ValueError('Saved rollout checkpoint differs')
    (output / 'boards').mkdir(parents=True)
    manifest = output / 'manifest.json'
    write_json(manifest, {**archive, 'source': str(source)})
    indexes = list(range(archive['boards']))
    emit({'stage': 'handoff rescoring', 'positions': len(indexes)})
    run_wave(manifest, indexes, args.workers, 0, worker_script=__file__)
    boards = [read(output / 'boards' / f'{i:04}.json') for i in indexes]
    samples = [(b['direct'], b['top_two']) for b in boards]
    report = {'all': evaluate(samples),
              'originally_complete': evaluate([(a, b) for a, b in samples if b['originally_complete']]),
              'extended_cutoff_prefixes': evaluate([(a, b) for a, b in samples if not b['originally_complete']])}
    write_json(output / 'results.json', report)
    emit(report)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
