"""Compare pre-resolution and resolved values on identical microsearch leaves."""
import argparse
import json
from pathlib import Path
import sys
from time import perf_counter

from nations_lookahead import SearchBoundary, SearchBudget
from nations_microsearch import MAIN, ADMIN, search, trace
from nations_policy import SharedScorer


def sample_roots(match_type, replay, owner):
    midgame, late = [], []

    class RecordingMatch(match_type):
        def get_move(self, player, prompt, options):
            if (self.phase.name == 'ACTION' and prompt == MAIN and player.name == owner
                    and self.move_list and len({str(o) for o in options} - ADMIN) > 1):
                solo = all(p is player or p.passed for p in self.players)
                if (self.round_number == 4 and not solo and not midgame) or (self.round_number == 8 and solo):
                    self.next_move_player, self.next_move_choice = player.name, prompt
                    self.next_move_options = tuple(map(str, options))
                    roots = late if solo else midgame
                    roots.append((self.get_replay(), self.get_state()))
            return super().get_move(player, prompt, options)

    def exhausted(*_):
        raise ValueError('Recorded game ended early')

    match = RecordingMatch(replay=replay, move_getter=exhausted)
    match.play()
    if not match.game_over or match.move_list:
        raise ValueError('Failed to recreate a completed game')
    return midgame + late[-2:]


def compare(match_type, prefix, state, predict):
    owner = state['next_move_player']
    original_options = []

    def pause(_prompt, options, _undo):
        original_options.extend(options)
        raise SearchBoundary('root')

    match = match_type(replay=prefix, move_getter=pause)
    try:
        match.play()
    except SearchBoundary:
        pass
    if match.move_number != state['move_number'] or tuple(map(str, original_options)) != state['next_move_options']:
        raise ValueError('Diagnostic replay failed to reproduce the root')

    leaves = []

    def collect(path, boundary, value):
        leaves.append((path, boundary, value))

    start = perf_counter()
    direct = predict(state)
    original = search(match, state, original_options, predict, direct, seconds=6, observe_leaf=collect)
    baseline_ms = (perf_counter() - start) * 1000
    old_path = original['line']
    row = {'round': state['round'], 'decision': state['move_number'], 'actor': owner,
           'direct_move': direct['moves'][0]['move'], 'search_nodes': original['nodes'],
           'budget': original['budget'], 'baseline_ms': baseline_ms}
    if not old_path:
        return row | {'status': 'no comparable baseline lines'}
    boundary = next(kind for path, kind, _ in leaves if path == old_path)
    row['boundary'] = boundary

    def resolve(state, legal):
        return next(move['move'] for move in predict(state)['moves'] if move['move'] in legal)

    start = perf_counter()
    candidates = []
    for path, kind, previous in leaves:
        if kind != boundary:
            continue
        try:
            outcome = trace(prefix, state, path, perf_counter() + 5, resolve_round=resolve)
        except SearchBudget:
            return row | {'status': 'forecast time limit'}
        if not outcome.state or outcome.boundary != boundary:
            return row | {'status': outcome.boundary or 'forecast changed boundary'}
        final = outcome.final_win is not None
        if final:
            score = float(outcome.final_win)
            margin = outcome.final_margin
        else:
            forecast = predict(outcome.state)['winProbability']
            score = forecast if outcome.state['next_move_player'] == owner else 1 - forecast
            scores = {name: p['score'] for name, p in outcome.state['players'].items()}
            margin = scores[owner] - scores[next(name for name in scores if name != owner)]
        candidates.append({'path': path, 'previous_probability': previous, 'resolved_value': score,
                           'resolved_vp_margin': margin, 'final': final})

    old = next(candidate for candidate in candidates if candidate['path'] == old_path)
    new = max(candidates, key=lambda c: (c['resolved_value'], c['resolved_vp_margin'] if c['final'] else 0,
                                        c['path'] == old_path))
    return row | {'status': 'compared', 'old': old, 'new': new, 'candidates': candidates,
                  'projection_ms': (perf_counter() - start) * 1000}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--shard', type=int, default=0)
    parser.add_argument('--shards', type=int, default=1)
    args = parser.parse_args()
    if not 0 <= args.shard < args.shards:
        parser.error('Invalid shard')
    sys.path.insert(0, str(args.engine.resolve()))
    from nations import Match

    games = []
    for folder in sorted(args.run.glob('shard-*')):
        for row in map(json.loads, (folder / 'games.jsonl').read_text(encoding='utf8').splitlines()):
            if not row['failure']:
                games.append((row, folder / 'replays' / f"{row['seed'][:16]}-{row['seat']}.replay"))
    scorer = SharedScorer()
    scorer.request({'loadExperimentalCheckpoint': str(args.checkpoint.resolve())})

    def predict(state):
        return scorer.request({'state': state, 'experimentalAnalysis': True})

    with args.output.open('x', encoding='utf8') as output:
        count = 0
        for game, replay in games[args.shard::args.shards]:
            for prefix, state in sample_roots(Match, replay.read_text(encoding='utf8'), f"Seat{game['seat']}"):
                row = compare(Match, prefix, state, predict) | {'seed': game['seed'], 'seat': game['seat']}
                output.write(json.dumps(row) + '\n')
                output.flush()
                count += 1
    print(f'Audited {count} replay positions', flush=True)


if __name__ == '__main__':
    main()
