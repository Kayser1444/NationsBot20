"""Verify public roots and fixed continuations against completed engine replays."""
import argparse
from collections import Counter, deque
from copy import deepcopy
from pathlib import Path
from time import perf_counter
import sys

from compare_position_checkpoints import read
from train import ROOT, write_json
from train_round_value import round_observation


def audit_file(path, counts, stride, examples):
    from nations import Match
    from nations.exceptions import GameOver
    from nations_lookahead import SearchBoundary
    from nations_move_safety import safe_architect_options, with_move_options
    from nations_public_round import PublicTurns, public_rollout

    turn = PublicTurns()
    samples = []
    choices = []
    prompts = []

    class RecordedMatch(Match):
        def resolution_phase(self):
            try:
                super().resolution_phase()
            except GameOver:
                settled()
                raise
            settled()

    def choose(prompt, options, undo):
        state = round_observation(match)
        turn.observe(state, match.get_log())
        guarded = safe_architect_options(match, prompt, options)
        prompts.append((state['next_move_player'], prompt, set(map(str, guarded)) - {'UNDO', 'Resign'}))
        if prompt == 'Which action?' and state['phase'] == 'Action Phase':
            counts['main prompts'] += 1
            actual = match.current_player.remaining_main_actions
            estimate = turn.remaining.get(state['next_move_player'])
            counts['action count matches'] += actual == estimate
            if counts['main prompts'] % stride == 0:
                samples.append((with_move_options(state, guarded), deepcopy(turn), len(choices)))
        choice = pending.popleft()
        choices.append(choice)
        return next(option for option in options if str(option) == choice)

    def settled():
        expected = round_observation(match)
        rules = {key: True for key in ('resource_remainder_tiebreaker', 'weighted_card_draw',
                                       'korea_nerf', 'lincoln_nerf') if getattr(match, key)}
        # A full line gives both engines the same choices through settlement.
        for state, ledger, offset in samples:
            counts['tested roots'] += 1
            position = offset
            equivalent = True

            def compare_prompt(actor, prompt, legal):
                nonlocal position, equivalent
                if position == offset:
                    counts['root legal menus matched'] += 1
                match = position < len(prompts) and prompts[position] == (actor, prompt, legal)
                counts['rollout menus compared'] += 1
                counts['rollout menus matched'] += match
                equivalent &= match
                position += 1

            try:
                actual = public_rollout(state, ledger, rules, tuple(choices[offset:]), None, None,
                                        perf_counter() + 2, observe=round_observation, on_prompt=compare_prompt)
            except SearchBoundary as error:
                counts[f'excluded: {error}'] += 1
                continue
            counts['complete lines'] += 1
            counts['complete lines with identical menus'] += equivalent and position == len(prompts)
            fields = ('players', 'player_order', 'progress_board', 'game_over', 'war', 'war_value', 'turmoil', 'architects')
            diffs = [key for key in fields if actual[key] != expected[key]]
            if not diffs:
                counts['exact settlements'] += 1
            for key in diffs:
                counts[f'difference: {key}'] += 1
            if 'players' in diffs:
                changed = {key for name, player in expected['players'].items() for key in player
                           if actual['players'][name].get(key) != player[key]}
                for key in changed:
                    counts[f'player difference: {key}'] += 1
            if diffs and len(examples) < 20:
                examples.append({'replay': path.name, 'round': state['round'], 'move': state['move_number'],
                                 'event': state['event'], 'fields': diffs,
                                 'changes': {name: {key: [actual['players'][name].get(key), player[key]]
                                                    for key in ('resources', 'points', 'production', 'worker_pools')
                                                    if actual['players'][name].get(key) != player[key]}
                                             for name, player in expected['players'].items()}})
        samples.clear()

    match = RecordedMatch(replay=path.read_text(encoding='utf-8'), move_getter=choose)
    pending = deque(match.move_list)
    match.move_list.clear()
    match.play()
    if pending or not match.game_over:
        raise ValueError(f'Incomplete audit replay: {path.name}')
    counts['games'] += 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--games', type=int, default=32)
    parser.add_argument('--stride', type=int, default=13)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if min(args.games, args.stride) < 1:
        parser.error('Use positive counts')
    manifest = read(args.reference / 'manifest.json')
    sys.path[:0] = [str(Path(manifest['batch']) / 'snapshot/engine'), str(ROOT / 'scripts')]
    counts = Counter()
    examples = []
    for path in sorted((args.reference / 'replays').glob('*.replay'))[:args.games]:
        audit_file(path, counts, args.stride, examples)
    write_json(args.output, {'counts': dict(counts), 'examples': examples})
    print(dict(counts), flush=True)


if __name__ == '__main__':
    main()
