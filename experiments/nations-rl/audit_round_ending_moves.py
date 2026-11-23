"""Compare policy preferences and value estimates at the last pass of each round."""
import argparse
from collections import Counter
from pathlib import Path
from statistics import mean
import sys
from time import perf_counter

import numpy as np
import torch

from audit_policy_reading import committed_prompts
from compare_position_checkpoints import read
from compare_position_encoding import StaticFallback, load_structured, position_encoder
from compare_position_microsearch import MicroPlayer
from model import collate
from train import ROOT, digest, seed_all, write_json
from train_round_value import load_round_value, round_observation


def agreement(rows):
    before = [row['pre_pass_win_estimate'] for row in rows]
    after = [row['settled_win_estimate'] for row in rows]
    return {'positions': len(rows), 'pearson': float(np.corrcoef(before, after)[0, 1]),
            'mean_absolute_difference': mean(abs(a - b) for a, b in zip(before, after)),
            'same_favorite': sum((a >= .5) == (b >= .5) for a, b in zip(before, after)),
            'mean_pre_pass': mean(before), 'mean_settled': mean(after)}


def rankings(rows):
    return dict(Counter(('tied' if not row['settled_prefers'] else
                         'agree' if row['policy_prefers'] == row['settled_prefers'] else 'disagree')
                        for row in rows))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('benchmark', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    setup = read(args.benchmark / 'manifest.json')
    batch = Path(setup['batch'])
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from nations_lookahead import SearchBoundary, SearchBudget
    from nations_microsearch import MAIN
    from nations_move_safety import safe_architect_options
    from nations_round_search import rollout_round

    policy = setup['challenger']
    path = Path(policy['path'])
    if digest(path) != policy['sha256'] or setup.get('policies') or setup['arms']['left'] != setup['arms']['right']:
        raise ValueError('Audit requires a single frozen policy and round scorer')
    seed_all(setup['seed'], 1)
    model = load_structured(path, policy['encoding']).requires_grad_(False)
    encoder = position_encoder(batch, policy['encoding'])
    score = load_round_value(batch, setup['arms']['left'])
    fallback = StaticFallback(batch)
    predictor = MicroPlayer(model, encoder, fallback, None, None, policy_rollouts=True).predict

    class ObservedMatch(Match):
        def get_move(self, player, choice, options):
            self.audit_options = options
            return super().get_move(player, choice, options)

        def resolution_phase(self):
            try:
                super().resolution_phase()
            finally:
                settlements[self.round_number] = round_observation(self)

    def observe_prompt(match):
        state = round_observation(match)
        if state['next_move_choice'] == MAIN:
            options = safe_architect_options(match, MAIN, match.audit_options)
            state['next_move_options'] = tuple(map(str, options))
        return state

    rows, skipped = [], Counter()
    try:
        for board in sorted((args.benchmark / 'boards').glob('*.json')):
            for game in read(board)['games']:
                settlements = {}
                archive = (args.benchmark / 'replays' / game['replay']).read_text(encoding='utf-8')
                prompts, scores = committed_prompts(ObservedMatch, archive, observe_prompt)
                if scores != game['scores'] or set(settlements) != set(range(1, 9)):
                    raise ValueError('Archived game did not reproduce its settlements')
                final_passes, earlier_choices = {}, {}
                for root, prefix, move in prompts:
                    owner = root['next_move_player']
                    if (root['next_move_choice'] == MAIN and root['phase'] == 'Action Phase'
                            and 'Pass' in root['next_move_options']
                            and all(p['passed'] for name, p in root['players'].items() if name != owner)):
                        if move == 'Pass':
                            final_passes[root['round']] = (True, root, prefix)
                        else:
                            earlier_choices.setdefault(root['round'], (False, root, prefix))
                if set(final_passes) != settlements.keys():
                    raise ValueError('Expected one final pass for every settled round')
                for played_pass, root, prefix in [*final_passes.values(), *earlier_choices.values()]:
                    round_number = root['round']
                    owner = root['next_move_player']
                    won = game['rewards'][owner] == 1.0
                    if not encoder.supports(root):
                        raise ValueError('Policy could not encode an ordinary final pass')
                    features, moves = encoder.encode(root)
                    with torch.inference_mode():
                        logits, value = model(collate([features]))
                    order = sorted(range(len(moves)), key=logits[0].tolist().__getitem__, reverse=True)
                    alternative = next((i for i in order if moves[i] != 'Pass'), None)
                    row = {'replay': game['replay'], 'round': round_number, 'actor': owner, 'won': won,
                           'played_pass': played_pass, 'policy_rank_of_pass': order.index(moves.index('Pass')) + 1,
                           'pre_pass_win_estimate': value.sigmoid().item()}
                    if played_pass:
                        row['settled_win_estimate'] = (score(settlements[round_number], owner)[0]
                                                       if round_number < 8 else float(won))
                    rows.append(row)
                    if alternative is None:
                        skipped['forced pass'] += 1
                        continue
                    branch_values = []
                    for move in ('Pass', moves[alternative]):
                        try:
                            outcome = rollout_round(prefix, root, (move,), predictor, lambda *_: None,
                                                    perf_counter() + 5, observe=round_observation)
                        except (SearchBoundary, SearchBudget) as error:
                            skipped[str(error) or type(error).__name__] += 1
                            break
                        if outcome['sampled_draw']:
                            skipped['Victoria Falls draw'] += 1
                            break
                        branch_values.append(score(outcome, owner))
                    if len(branch_values) == 2:
                        passing, continuing = branch_values
                        row.update(alternative=moves[alternative], pass_value=passing, alternative_value=continuing,
                                   policy_prefers='pass' if order[0] == moves.index('Pass') else 'alternative',
                                   settled_prefers=('pass' if passing > continuing else
                                                    'alternative' if passing < continuing else None))
    finally:
        fallback.close()

    early = [row for row in rows if row['played_pass'] and row['round'] < 8]
    final = [row for row in rows if row['played_pass'] and row['round'] == 8]
    compared = [row for row in rows if row['played_pass'] and 'alternative' in row]
    early_compared = [row for row in compared if row['round'] < 8]
    summary = {'learned_win_estimates': agreement(early), 'final_win_estimates': agreement(final),
               'learned_rankings': rankings(early_compared),
               'learned_rankings_by_policy_choice': {choice: rankings([r for r in early_compared
                   if r['policy_prefers'] == choice]) for choice in ('pass', 'alternative')},
               'learned_rankings_with_five_point_gap': rankings([r for r in early_compared
                   if abs(r['pass_value'][0] - r['alternative_value'][0]) >= .05]),
               'exact_final_rankings': rankings([row for row in compared if row['round'] == 8]),
               'earlier_eligible_rankings': {label: rankings([row for row in rows if not row['played_pass']
                    and 'alternative' in row and (row['round'] == 8) == is_final])
                    for label, is_final in (('learned', False), ('exact', True))},
               'skipped_alternatives': dict(skipped)}
    write_json(args.output, {'summary': summary, 'cases': rows})
    print(summary)


if __name__ == '__main__':
    main()
