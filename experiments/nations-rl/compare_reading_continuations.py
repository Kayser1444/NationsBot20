"""Run paired policy rollouts from archived positions where top-two overrides the policy."""
import argparse
from collections import Counter
from pathlib import Path
from random import Random
from statistics import mean
import sys
from time import perf_counter

from audit_policy_reading import committed_prompts
from compare_position_checkpoints import read, run_wave
from compare_position_encoding import StaticFallback, load_structured, position_encoder
from compare_position_microsearch import MicroPlayer
from train import ROOT, digest, emit, seed_all, write_json


class AtRoot(Exception):
    pass


def observation(match):
    return {**match.get_state(), 'growth_allowances': {p.name: p.growth_resources for p in match.players},
            'weighted_card_draw': match.weighted_card_draw}


def direct_line(prefix, root, predict, trace):
    """Score the path direct play takes up to the same class of stopping point."""
    from nations_microsearch import HANDOFFS

    state, path, value = root, (), None
    deadline = perf_counter() + 15
    while perf_counter() < deadline:
        prediction = predict(state)
        if prediction['winProbability'] is not None:
            value = prediction['winProbability']
        path += (prediction['moves'][0]['move'],)
        successor = trace(prefix, root, path, deadline, pre_move=True)
        if successor.boundary:
            if successor.boundary not in HANDOFFS:
                raise ValueError(f'Direct line failed: {successor.boundary}')
            return {'moves': list(path), 'value': value, 'boundary': successor.boundary}
        state = successor.state
    raise ValueError('Direct line did not reach a handoff')


def rollout(match_type, prefix, root, moves, predict, replay_path):
    from nations_microsearch import ADMIN
    from nations_move_safety import safe_architect_options, with_move_options

    owner = root['next_move_player']
    offset = 0

    def choose(prompt, options, _undo):
        nonlocal offset
        if match.invalid_move:
            raise ValueError(f'Engine rejected {match.invalid_move}')
        state = observation(match)
        options = safe_architect_options(match, prompt, options)
        legal = {str(option): option for option in options if str(option) not in ADMIN}
        if offset == 0 and state != root:
            raise ValueError('Rollout did not reconstruct the same root observation')
        if not legal:
            raise ValueError(f'No playable choices at {prompt}')
        if offset and len(legal) == 1:
            return next(iter(legal.values()))
        if offset < len(moves):
            move = moves[offset]
            if state['next_move_player'] != owner or move not in legal:
                raise ValueError(f'Planned move {move!r} is unavailable at {prompt}')
            offset += 1
        else:
            move = predict(with_move_options(state, options))['moves'][0]['move']
        return legal[move]

    match = match_type(replay=prefix, move_getter=choose)
    match.play()
    if offset != len(moves) or not match.game_over or match.round_number != 8 or match.phase.name != 'SCORING':
        raise ValueError('Rollout did not execute the line and reach final scoring')
    scores = {p.name: p.score() for p in match.players}
    rival = next(p.name for p in match.players if p.name != owner)
    winner = min(match.players, key=lambda p: (
        -scores[p.name], -p.resource_remainder() if match.resource_remainder_tiebreaker else 0))
    replay_path.write_text(match.get_replay(), encoding='utf-8')
    return {'scores': scores, 'won': winner.name == owner, 'margin': scores[owner] - scores[rival],
            'replay': replay_path.name}


def evaluate_board(match_type, source, output, index, searcher, direct, trace, random_seed):
    from nations_lookahead import SearchBudget
    from nations_microsearch import ADMIN, MAIN, search_best_first

    board = read(source / 'boards' / f'{index:04}.json')
    rng = Random(random_seed + index)
    candidates = []
    counts = Counter()
    failures = []
    for game in board['games']:
        if game['error']:
            continue
        replay = (source / 'replays' / game['replay']).read_text(encoding='utf-8')
        prompts, scores = committed_prompts(match_type, replay, observation)
        if scores != game['scores']:
            raise ValueError('Archived game failed replay validation')
        candidates.extend((state, prefix, picked, game['replay']) for state, prefix, picked in prompts
                          if state['next_move_player'] == game['candidate'] and state['next_move_choice'] == MAIN
                          and state['phase'] == 'Action Phase' and len(set(state['next_move_options']) - ADMIN) > 1)
    rng.shuffle(candidates)
    for archived, prefix, picked, archived_replay in candidates:
        if direct.predict(archived)['moves'][0]['move'] == picked:
            continue

        def choose(_prompt, options, _undo):
            root = observation(match)
            if root != archived:
                raise ValueError('Archive prefix did not reach the recorded prompt')
            prediction = searcher.predict(root)
            policy_move = prediction['moves'][0]['move']
            if policy_move != picked:
                counts['archived_overrides_checked'] += 1
                result = search_best_first(match, root, options, searcher.predict, prediction, **searcher.limits)
                if result['line'] and result['line'][0] != policy_move:
                    counts['overrides_reproduced'] += 1
                    counts['same_override_as_archive'] += result['line'][0] == picked
                    proposed.update(root=root, search=result)
            raise AtRoot()

        proposed = {}
        match = match_type(replay=prefix, move_getter=choose)
        try:
            match.play()
        except AtRoot:
            pass
        if not proposed:
            continue
        root, search = proposed['root'], proposed['search']
        stem = f"{index:04}-{root['next_move_player']}-{root['move_number']}"
        try:
            baseline = direct_line(prefix, root, direct.predict, trace)
            alternative = {'moves': list(search['line']), 'value': search['line_value'],
                           'boundary': search['line_boundary']}
            for label, line in (('direct', baseline), ('top_two', alternative)):
                line.update(rollout(match_type, prefix, root, line['moves'], direct.predict,
                                    output / 'replays' / f'{stem}-{label}.replay'))
        except (ValueError, AttributeError, KeyError, SearchBudget) as error:
            failures.append({'move_number': root['move_number'], 'error': f'{type(error).__name__}: {error}'})
            continue
        return {'index': index, 'seed': board['seed'], 'counts': dict(counts), 'failures': failures,
                'sample': {'archive': archived_replay, 'actor': root['next_move_player'], 'round': root['round'],
                           'move_number': root['move_number'], 'difficulty': root['growth_allowances'][root['next_move_player']],
                           'budget_hit': search['budget'], 'archived_move': picked,
                           'direct': baseline, 'top_two': alternative}}
    return {'index': index, 'seed': board['seed'], 'counts': dict(counts), 'failures': failures, 'sample': None}


def worker(manifest_path, jobs_path):
    manifest = read(manifest_path)
    batch = Path(manifest['batch'])
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from nations_microsearch import search_best_first, trace

    seed_all(manifest['seed'], 1)
    schema = manifest['encoding']
    encoder = position_encoder(batch, schema)
    model = load_structured(Path(manifest['challenger']['path']), schema)
    fallback = StaticFallback(batch)
    output = manifest_path.parent
    try:
        searcher = MicroPlayer(model, encoder, fallback, '', search_best_first, manifest['search'])
        direct = MicroPlayer(model, encoder, fallback, '', search_best_first, strict_direct=True)
        for index in read(jobs_path):
            result = evaluate_board(Match, Path(manifest['source']), output, index, searcher, direct, trace,
                                    manifest['seed'])
            write_json(output / 'boards' / f'{index:04}.json', result)
    finally:
        fallback.close()


def summarize(samples):
    n = len(samples)
    direct = [s['direct'] for s in samples]
    search = [s['top_two'] for s in samples]
    changes = [(b['won'] - a['won'], b['margin'] - a['margin']) for a, b in zip(direct, search)]
    if not changes:
        return {'positions': 0}
    rng = Random(197)
    draws = [rng.choices(changes, k=n) for _ in range(4000)]
    intervals = [sorted(mean(d[i] for d in draw) for draw in draws) for i in range(2)]
    return {'positions': n, 'direct_wins': sum(a['won'] for a in direct), 'top_two_wins': sum(b['won'] for b in search),
            'direct_mean_margin': mean(a['margin'] for a in direct), 'top_two_mean_margin': mean(b['margin'] for b in search),
            'mean_estimated_win_probability_change': mean(b['value'] - a['value'] for a, b in zip(direct, search)),
            'win_rate_change': mean(w for w, _ in changes), 'mean_vp_change': mean(m for _, m in changes),
            'win_rate_change_95': [intervals[0][100], intervals[0][3899]],
            'mean_vp_change_95': [intervals[1][100], intervals[1][3899]],
            'wins_changed': dict(Counter('improved' if w > 0 else 'worsened' if w < 0 else 'same' for w, _ in changes)),
            'vp_changed': dict(Counter('improved' if m > 0 else 'worsened' if m < 0 else 'same' for _, m in changes))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--boards', type=int, default=128)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--seed', type=int, default=181179)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    original = read(source / 'manifest.json')
    if not 0 < args.boards <= len(original['boards']) or args.workers < 1:
        parser.error('Board and worker counts must be positive and within the archive')
    if (not original.get('best_first') or original['search']['width'] != 2 or 'rule_mix' not in original
            or digest(Path(original['challenger']['path'])) != original['challenger']['sha256']):
        raise ValueError('Expected the frozen mixed-settings top-two benchmark')
    manifest = {key: original[key] for key in ('batch', 'encoding', 'challenger', 'rule_mix', 'search')}
    manifest.update(source=str(source), seed=args.seed, boards=args.boards)
    for directory in ('boards', 'replays'):
        (output / directory).mkdir(parents=True)
    write_json(output / 'manifest.json', manifest)
    emit({'stage': 'continuation sample', 'boards': args.boards})
    run_wave(output / 'manifest.json', list(range(args.boards)), args.workers, 0, worker_script=__file__)
    boards = [read(output / 'boards' / f'{i:04}.json') for i in range(args.boards)]
    samples = [b['sample'] for b in boards if b['sample'] is not None]
    counts = Counter()
    for board in boards:
        counts.update(board['counts'])
    report = {'overall': summarize(samples), 'selection_counts': dict(counts),
              'rejected_rollouts': sum(len(b['failures']) for b in boards),
              'by_estimated_value': {label: summarize([s for s in samples if ordering(s) == label])
                                     for label in ('top_two_higher', 'equal', 'direct_higher')},
              'both_reached_handoff': summarize([s for s in samples if s['top_two']['boundary']]),
              'search_prefix_at_cutoff': summarize([s for s in samples if not s['top_two']['boundary']])}
    write_json(output / 'results.json', report)
    emit(report)


def ordering(sample):
    difference = sample['top_two']['value'] - sample['direct']['value']
    return 'equal' if abs(difference) < 1e-7 else 'top_two_higher' if difference > 0 else 'direct_higher'


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
