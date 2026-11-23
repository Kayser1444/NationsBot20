"""Benchmark microsearch against direct play on fixed boards."""
import argparse
from collections import Counter
from pathlib import Path
import random
from statistics import mean, median
import sys
from time import perf_counter

import torch

from ability_encoding import ReplacementAbilityEncoder
from compare_position_checkpoints import read, run_wave
from compare_position_encoding import LegacyInput, StaticFallback, load_structured, position_encoder
from encoding import Encoder, legal_moves
from model import collate, load_model
from position_encoding import SCHEMA
from train import (CONFIRMATIONS, ROOT, RULES, digest, emit, paired_improvement, play_game, seed_all,
                   summarize, write_json)


SEARCH = {'max_depth': 3, 'max_nodes': 40, 'seconds': .28}
PRE_MOVE_SEARCH = {'max_nodes': 64, 'seconds': .45}
ROUND_SEARCH = {'max_lines': 4, 'max_attempts': 12, 'seconds': .35, 'hard_seconds': 3}


class MicroPlayer:
    def __init__(self, model, encoder, fallback, owner, search, limits=SEARCH, *, strict_direct=False,
                 value_score=None, policy_rollouts=False):
        self.model, self.encoder, self.fallback = model, encoder, fallback
        self.owner, self.search = owner, search
        self.limits = limits
        self.strict_direct = strict_direct
        self.value_score = value_score
        self.policy_rollouts = policy_rollouts
        self.plan = ()
        self.frontier = None
        self.counts = Counter()
        self.timings = []

    @torch.inference_mode()
    def predict(self, state):
        aliases = self.encoder.move_aliases(state)
        supported = self.encoder.supports(state)
        if self.policy_rollouts:
            options = state['next_move_options']
            confirm = next((move for move in CONFIRMATIONS if move in options), None)
            if confirm is not None or not supported:
                # Match direct play on forced confirmations. Rank any other
                # choices with the existing fallback when the policy cannot.
                menu = {**state, 'next_move_options': [move for move in options if move not in CONFIRMATIONS]}
                fallback = self.fallback.rank(menu)
                moves = [confirm] if confirm is not None else []
                moves.extend(aliases.get(row['move'], row['move']) for row in fallback)
                return {'moves': [{'move': move} for move in dict.fromkeys(moves)], 'move_aliases': aliases}
        if self.strict_direct:
            for confirm in CONFIRMATIONS:
                if confirm in state['next_move_options']:
                    return {'moves': [{'move': confirm}], 'winProbability': None}
            if not supported:
                move = self.fallback.choose(state)
                return {'moves': [{'move': aliases.get(move, move)}], 'winProbability': None,
                        'move_aliases': aliases}
        if not supported:
            return {'moves': self.fallback.rank(state), 'winProbability': None, 'move_aliases': aliases}
        features, moves = self.encoder.encode(state)
        logits, value = self.model(collate([features]))
        scores = logits[0].tolist()
        order = sorted(range(len(moves)), key=scores.__getitem__, reverse=True)
        if self.policy_rollouts:
            top = scores[order[0]]
            return {'moves': [{'move': moves[index], 'policy_gap': top - scores[index]} for index in order],
                    'move_aliases': aliases}
        return {'moves': [{'move': moves[index]} for index in order],
                'winProbability': value.sigmoid().item(), 'move_aliases': aliases}

    def choose(self, match, state, options):
        own_turn = state['next_move_player'] == self.owner
        if self.plan:
            move = self.plan[0]
            if own_turn and move in state['next_move_options']:
                self.plan = self.plan[1:]
                self.counts['planned_followups'] += 1
                return move
            # The engine can offer a forced step between planned choices.
            moves = legal_moves(state)
            if own_turn and len(moves) <= 1:
                return None
            self.plan = ()
            self.frontier = None
            self.counts['interrupted_plans'] += 1
        resume = self.frontier
        if not own_turn or match.phase.name != 'ACTION':
            self.frontier = None
            return None
        if resume is not None:
            if state['move_number'] < resume['move_number']:
                return None
            self.frontier = None
            if (state['move_number'] != resume['move_number']
                    or state['next_move_choice'] != resume['prompt']
                    or not set(resume['choices']) <= set(state['next_move_options'])):
                self.counts['interrupted_frontiers'] += 1
                resume = None
        if resume is None and (state['next_move_choice'] != 'Which action?' or len(legal_moves(state)) < 2):
            return None
        direct = self.predict(state)
        settings = self.limits
        if self.value_score is not None:
            if not self.policy_rollouts:
                if state['next_move_choice'] == 'Which action?':
                    counts = {p.name: p.remaining_main_actions for p in match.players}
                    direct['winProbability'] = self.value_score(state, self.owner, self.owner, counts)
                else:
                    direct['winProbability'] = None
            settings = {**settings, 'value_score': self.value_score}
        if resume is not None:
            self.counts['resumed_searches'] += 1
            ranked = (row['move'] for row in direct['moves'] if row['move'] in resume['choices'])
            best = next(ranked, resume['choices'][0])
            settings = {**settings, 'resume': resume}
        else:
            best = direct['moves'][0]['move']
        outcome = self.search(match, state, options, self.predict, direct, **settings)
        self.counts['searched'] += 1
        self.counts['budget_reached'] += outcome['budget']
        self.counts['duplicate_positions'] += outcome['boundaries'].get('duplicate positions', 0)
        if 'selected_scored_handoff' in outcome:
            self.counts['scored_handoffs'] += outcome['boundaries'].get('scored handoffs', 0)
            self.counts['selected_scored_handoff'] += outcome['selected_scored_handoff']
        if self.policy_rollouts:
            direct_value = outcome['direct_line_value']
            self.counts['direct_handoffs_scored'] += direct_value is not None
            self.counts['searches_with_comparison'] += outcome['boundaries'].get('scored handoffs', 0) > 1
            self.counts['alternatives_chosen'] += direct_value is not None and outcome['line_value'] > direct_value
        if 'score_cutoff' in outcome:
            self.counts['score_cutoffs'] += outcome['score_cutoff']
            if state['next_move_choice'] == 'Which action?':
                self.counts['main_searches'] += 1
                roots = outcome['boundaries'].get('root branches inspected', 0)
                self.counts['main_searches_beyond_two_roots'] += roots > 2
        self.counts['nodes'] += outcome['nodes']
        self.timings.append(outcome['duration_ms'])
        if outcome['line']:
            self.counts['compared'] += 1
            self.counts['budget_kept_plan'] += outcome['budget']
            if 'score_cutoff' in outcome:
                self.counts['score_cutoff_kept_plan'] += outcome['score_cutoff']
            move, *followups = outcome['line']
            self.plan = tuple(followups)
            self.frontier = outcome.get('resume')
            self.counts['partial_plans'] += self.frontier is not None
            self.counts['changed_move'] += move != best
            return move
        return best


class RoundPlayer(MicroPlayer):
    phases = frozenset(('ACTION', 'PRODUCTION', 'PLAYER_ORDER', 'WAR', 'EVENTS', 'FAMINE',
                        'DISCARD_TURMOIL', 'SCORE_BOOKS'))

    def __init__(self, *args, **kwargs):
        from nations_round_search import RoundSearchMemory

        super().__init__(*args, **kwargs)
        self.memory = RoundSearchMemory()

    def choose(self, match, state, options):
        from nations_microsearch import ADMIN
        from train_round_value import round_observation

        if state['next_move_player'] != self.owner or match.phase.name not in self.phases:
            return None
        if len(set(state['next_move_options']) - ADMIN) < 2:
            return None
        selected, counts, duration = self.search(match, state, options, self.predict, self.predict(state),
                                                 value_score=self.value_score, observe=round_observation,
                                                 memory=self.memory, **self.limits)
        self.counts.update(counts)
        if counts['searched']:
            self.timings.append(duration)
        else:
            self.counts['equivalent_options'] += 1
        return selected


def worker(manifest_path, jobs_path):
    manifest = read(manifest_path)
    batch, output = Path(manifest['batch']), manifest_path.parent
    seed_all(manifest['seed'], 1)
    sys.path[:0] = [str(batch / 'snapshot/engine'), str(ROOT / 'scripts')]
    from nations import Match
    from nations_microsearch import (search, search_best_first, search_broad_best_first,
                                     search_policy_rollouts, search_pre_move)

    schema = manifest.get('encoding', SCHEMA)
    encoder = position_encoder(batch, schema)
    if schema != SCHEMA and list(encoder.ability_ids) != manifest['ability_ids']:
        raise ValueError('The benchmark catalog differs from the training catalog')
    opponent_encoder = Encoder(encoder.cards) if isinstance(encoder, ReplacementAbilityEncoder) else None
    model = load_structured(Path(manifest['challenger']['path']), schema)
    policy_rollouts = manifest.get('policy_rollouts', False)
    round_rollouts = manifest.get('round_rollouts', False)
    value_score = None
    if round_rollouts:
        from train_round_value import load_round_value

        value_score = load_round_value(batch, manifest['value_head'])
    elif 'value_head' in manifest:
        from train_handoff_value import load_search_value

        value_score = load_search_value(encoder, model, manifest['challenger']['sha256'], manifest['value_head'],
                                        handoff_only=policy_rollouts)
    opponent = manifest['benchmark']
    if 'encoding' in opponent:
        opponent_encoder = position_encoder(batch, opponent['encoding'])
        old = load_structured(Path(opponent['path']), opponent['encoding'])
    else:
        old = LegacyInput(load_model(Path(opponent['path']))[0].eval())
    search_mode = search
    if round_rollouts:
        from nations_round_search import search_round

        search_mode = search_round
    elif policy_rollouts:
        search_mode = search_policy_rollouts
    elif manifest['search']['width'] is None:
        search_mode = search_broad_best_first
    elif manifest.get('best_first'):
        search_mode = search_best_first
    elif manifest.get('pre_move'):
        search_mode = search_pre_move
    limits = {key: value for key, value in manifest['search'].items() if key != 'width'}
    if search_mode is search_best_first:
        limits['width'] = manifest['search']['width']
    strict_direct = limits.get('strict_direct', False)
    fallback = StaticFallback(batch)
    try:
        for index in read(jobs_path):
            seed = manifest['boards'][index]
            rules = manifest['board_rules'][index] if 'board_rules' in manifest else None
            games = []
            for seat in range(2):
                own, rival = f'Seat{seat}', f'Seat{1 - seat}'
                replay = output / 'replays' / f'{seed[:16]}-{seat}.replay'
                player_type = RoundPlayer if round_rollouts else MicroPlayer
                player = player_type(model, encoder, fallback, own, search_mode, limits,
                                     strict_direct=strict_direct, value_score=value_score,
                                     policy_rollouts=policy_rollouts or round_rollouts)
                policy_encoders = {rival: opponent_encoder} if opponent_encoder is not None else None
                row, _ = play_game(Match, encoder, fallback, {own: model, rival: old}, (), seed, replay,
                                   sample=False, sampling_seed=0, seconds=300, move_override=player.choose,
                                   policy_encoders=policy_encoders, rules=rules)
                games.append(row | {'candidate': own, 'opponent': rival,
                                    'search_counts': dict(player.counts), 'search_ms': player.timings})
            write_json(output / 'boards' / f'{index:04}.json', {'index': index, 'seed': seed, 'games': games})
    finally:
        fallback.close()


def report_results(output, seeds, reference, reference_path=None):
    boards = [read(output / 'boards' / f'{index:04}.json') for index in range(len(seeds))]
    results = []
    for index, (board, seed) in enumerate(zip(boards, seeds)):
        if board['index'] != index or board['seed'] != seed or len(board['games']) != 2:
            raise ValueError('Incomplete or mismatched board')
        if {g['candidate'] for g in board['games']} != {'Seat0', 'Seat1'}:
            raise ValueError('Expected one game in each seat')
        for game in board['games']:
            if game['seed'] != seed or not (output / 'replays' / game['replay']).is_file():
                raise ValueError('Mismatched game or missing replay')
            if game.get('rules') != reference[(seed, game['candidate'])].get('rules'):
                raise ValueError('Search game used different rules from direct play')
        results.extend(board['games'])
    good_boards = [board for board in boards if all(not g['error'] for g in board['games'])]
    micro = [g for board in good_boards for g in board['games']]
    direct = [reference[(g['seed'], g['candidate'])] for g in micro]
    paired = paired_improvement(direct, micro) if micro else {}

    def margin(game):
        return game['scores'][game['candidate']] - game['scores'][game['opponent']]

    vp = [mean(margin(g) - margin(reference[(g['seed'], g['candidate'])]) for g in board['games'])
          for board in good_boards]
    if vp:
        rng = random.Random(197)
        draws = sorted(mean(rng.choices(vp, k=len(vp))) for _ in range(4000))
        paired.update(mean_vp_margin_difference=mean(vp), mean_vp_margin_difference_95=[draws[100], draws[3899]])
    counts = Counter()
    for row in results:
        counts.update(row['search_counts'])
    timings = sorted(t for row in results for t in row['search_ms'])
    report = {
        'boards': len(boards), 'complete_pairs': len(good_boards), 'all_scheduled_games': summarize(results),
        'direct_matched': summarize(direct), 'micro_matched': summarize(micro), 'paired': paired,
        'search_counts': dict(counts), 'search_p50_ms': median(timings) if timings else None,
        'search_p95_ms': timings[int(.95 * (len(timings) - 1))] if timings else None,
        'mean_game_seconds': {'direct': mean(g['duration_seconds'] for g in direct) if direct else None,
                              'search': mean(g['duration_seconds'] for g in micro) if micro else None},
        'failures': [row for row in results if row['error']],
    }
    if reference_path is not None:
        mismatched = []
        for game in results:
            original = reference[(game['seed'], game['candidate'])]
            same_replay = ((output / 'replays' / game['replay']).read_text(encoding='utf-8') ==
                           (reference_path / 'replays' / original['replay']).read_text(encoding='utf-8'))
            fields = ('scores', 'remainders', 'rewards', 'decisions')
            if game['error'] or not same_replay or any(game.get(key) != original.get(key) for key in fields):
                mismatched.append(game['replay'])
        report['strict_parity'] = {'identical_replays': len(results) - len(mismatched),
                                   'identical_decisions': sum(g['decisions'] for g in results
                                                              if g['replay'] not in mismatched),
                                   'mismatched_replays': mismatched}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--checkpoint', type=int)
    parser.add_argument('--opponent-checkpoint', type=int,
                        help='Use a checkpoint from the archived head-to-head reference as the opponent.')
    parser.add_argument('--pre-move', action='store_true',
                        help='Use the policy checkpoint only at actual pre-move decision prompts.')
    parser.add_argument('--best-first', action='store_true',
                        help='Keep the best reached line when the search budget runs out.')
    parser.add_argument('--width', type=int, choices=(1, 2), default=2)
    parser.add_argument('--strict-direct', action='store_true',
                        help='At width one, use the exact direct-play decision rules at every prompt.')
    parser.add_argument('--handoff-score', action='store_true',
                        help='Rank completed best-first lines using the resolved position.')
    rollouts = parser.add_mutually_exclusive_group()
    rollouts.add_argument('--policy-rollouts', action='store_true',
                          help='Complete the direct line first, then policy-prioritized alternatives to handoff.')
    rollouts.add_argument('--round-rollouts', action='store_true',
                          help='Compare policy-guided lines after full round or age resolution.')
    parser.add_argument('--value-head', type=Path,
                        help='Use a retrained value head with the unchanged move-ranking policy.')
    gaps = parser.add_mutually_exclusive_group()
    gaps.add_argument('--score-gap', type=float,
                      help='Queue all eligible moves and stop at this gap in estimated win probability.')
    gaps.add_argument('--top-two-score-gap', type=float,
                      help='Keep top-two width and stop at this gap in estimated win probability.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--board-limit', type=int, help='Use a short prefix for a smoke check.')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if args.workers < 1 or args.board_limit is not None and args.board_limit < 1:
        parser.error('Worker and board counts must be positive')
    if args.best_first and not args.pre_move:
        parser.error('--best-first requires --pre-move')
    if args.width == 1 and (not args.best_first or args.score_gap is not None):
        parser.error('--width 1 requires --best-first without --score-gap')
    if args.strict_direct and args.width != 1:
        parser.error('--strict-direct requires --width 1')
    if args.handoff_score and (
            not args.best_first or args.width != 2 or args.score_gap is not None or args.top_two_score_gap is not None):
        parser.error('--handoff-score requires best-first top-two without a score cutoff')
    if args.policy_rollouts and (args.value_head is None or args.best_first or args.strict_direct
                                or args.handoff_score or args.score_gap is not None
                                or args.top_two_score_gap is not None or args.width != 2):
        parser.error('--policy-rollouts requires a handoff-only --value-head and uses all policy-ranked branches')
    if args.round_rollouts and (args.reference is None or args.checkpoint is None or args.value_head is None
                               or args.best_first or args.strict_direct or args.handoff_score
                               or args.score_gap is not None or args.top_two_score_gap is not None
                               or args.width != 2):
        parser.error('--round-rollouts requires a settled-round --value-head, --reference and --checkpoint')
    if args.value_head is not None and not (args.handoff_score or args.policy_rollouts or args.round_rollouts):
        parser.error('--value-head requires --handoff-score, --policy-rollouts or --round-rollouts')
    if args.score_gap is not None and (not args.best_first or not 0 < args.score_gap <= 1):
        parser.error('--score-gap requires --best-first and a gap between 0 and 1')
    if args.top_two_score_gap is not None and (
            not args.best_first or args.width != 2 or not 0 < args.top_two_score_gap <= 1):
        parser.error('--top-two-score-gap requires --best-first at width two and a gap between 0 and 1')
    default_reference = 'ability-replacement-last-four-768-v1' if args.pre_move else 'current-position-256-boards-v1'
    checkpoint = str(args.checkpoint or (35000 if args.pre_move else 6000))
    output = args.output.resolve()
    reference_path = (args.reference or ROOT / '.data/nations-rl' / default_reference).resolve()
    prior = read(reference_path / 'manifest.json')
    if prior['rules'] != RULES:
        raise ValueError('Benchmark rules differ from the direct-play experiment')
    challenger = prior['checkpoints'][checkpoint]
    opponent_label = str(args.opponent_checkpoint) if args.opponent_checkpoint is not None else 'benchmark'
    if (opponent_label != 'benchmark') != prior.get('round_robin', False) or checkpoint == opponent_label:
        parser.error('Head-to-head references require a distinct --opponent-checkpoint')
    benchmark = prior['benchmark'] if opponent_label == 'benchmark' else prior['checkpoints'][opponent_label]
    reference_pair = f'{checkpoint}-vs-{opponent_label}'
    reverse_pair = f'{opponent_label}-vs-{checkpoint}'
    for model in (challenger, benchmark):
        if digest(Path(model['path'])) != model['sha256']:
            raise ValueError('A checkpoint differs from the direct-play experiment')
    recorded = [read(path) for path in sorted((reference_path / 'boards').glob('*.json'))]
    boards = [board for board in recorded if all(not game['error'] for game in board['games'])]
    if len(boards) != prior['boards']:
        raise ValueError('Missing completed reference boards')
    boards = boards[:args.board_limit]
    reference = {}
    for board in boards:
        for row in board['games']:
            if row['pair'] == reverse_pair:
                row = {**row, 'candidate': row['opponent'], 'opponent': row['candidate'], 'pair': reference_pair}
            if row['pair'] == reference_pair:
                reference[row['seed'], row['candidate']] = row
    if len(reference) != 2 * len(boards):
        raise ValueError(f'Missing {checkpoint}-game direct-play reference seats')
    manifest = output / 'manifest.json'
    config = {'batch': prior['batch'], 'rules': RULES, 'seed': prior['seed'],
              'boards': [board['seed'] for board in boards],
              'search_engine': 'standalone-undeploy-shared-dedup-v1',
              'search': (PRE_MOVE_SEARCH if args.pre_move else SEARCH) | {'width': args.width},
              'challenger': challenger, 'benchmark': benchmark, 'reference': str(reference_path)}
    if args.pre_move:
        config['pre_move'] = True
    if args.policy_rollouts:
        config['policy_rollouts'] = True
        config['search'] = {**PRE_MOVE_SEARCH, 'width': None}
    if args.round_rollouts:
        config['round_rollouts'] = True
        config['search_engine'] = 'settled-round-policy-rollouts-v1'
        config['search'] = ROUND_SEARCH
    if args.best_first:
        config['best_first'] = True
    if args.score_gap is not None:
        config['search'].update(width=None, score_gap=args.score_gap)
    if args.top_two_score_gap is not None:
        config['search']['score_gap'] = args.top_two_score_gap
    if args.strict_direct:
        config['search']['strict_direct'] = True
    if args.handoff_score:
        config['search']['handoff_score'] = True
    if args.value_head is not None:
        value_head = args.value_head.resolve()
        config['value_head'] = {'path': str(value_head), 'sha256': digest(value_head)}
    if 'encoding' in prior:
        config.update(encoding=challenger.get('encoding', prior['encoding']), ability_ids=prior['ability_ids'])
    if 'rule_mix' in prior:
        config['rule_mix'] = prior['rule_mix']
        config['board_rules'] = [reference[board['seed'], 'Seat0']['rules'] for board in boards]
        if any(reference[board['seed'], 'Seat1']['rules'] != rules
               for board, rules in zip(boards, config['board_rules'])):
            raise ValueError('Archived seats used different rules on the same board')
    if args.resume:
        if read(manifest) != config or (output / 'results.json').exists():
            raise ValueError('Resume requires an unfinished run with the same inputs')
    else:
        output.mkdir(parents=True)
        (output / 'boards').mkdir()
        (output / 'replays').mkdir()
        write_json(manifest, config)
    started = perf_counter()
    todo = [index for index in range(len(boards)) if not (output / 'boards' / f'{index:04}.json').exists()]
    if todo:
        wave = len(list(output.glob('wave-*-worker-00.json')))
        emit({'stage': 'microsearch', 'scheduled_boards': len(todo), 'games': 2 * len(todo)})
        run_wave(manifest, todo, args.workers, wave, worker_script=__file__)
    report = report_results(output, config['boards'], reference, reference_path if args.strict_direct else None)
    report['seconds'] = round(perf_counter() - started, 2)
    write_json(output / 'results.json', report)
    emit({'stage': 'complete', **report})
    if args.strict_direct and report['strict_parity']['mismatched_replays']:
        raise SystemExit('Strict top-one differs from direct play; see results.json')


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
