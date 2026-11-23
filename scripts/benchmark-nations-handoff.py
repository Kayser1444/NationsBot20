"""Measure exhaustive public action paths in completed Tabony replays."""

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
from random import Random
import sys
import tarfile
from time import perf_counter, process_time

from nations_lookahead import SearchBoundary, lock_hidden_information
from nations_move_safety import safe_architect_options


ENGINE = Path(__file__).resolve().parents[2] / 'nations-server' / 'Nations'
sys.path.insert(0, str(ENGINE))
from nations import Match  # noqa: E402
from nations.phases import Phase  # noqa: E402
from nations_search_state import decision_key, freeze, standalone_undeploy_allowed


ADMIN = {'UNDO', 'Resign'}
UNDEPLOY = 'Undeploy from '
DEPLOY = 'Deploy to '
UNDEPLOY_RANK_HOOKS = ('updating most least stability military', 'force least stability',
                       'least stability', 'least military')


def sampled_roots(replay, rng):
    groups = defaultdict(list)

    class RecordingMatch(Match):
        def get_move(self, player, choice, options):
            offered = tuple(map(str, options))
            if (self.phase is Phase.ACTION and choice == 'Which action?' and self.move_list
                    and self.move_list[0] in offered and len(set(offered) - ADMIN) > 1):
                solo = all(other is player or other.passed for other in self.players)
                groups[solo, (self.round_number + 1) // 2].append({
                    'round': self.round_number, 'move': self.move_number, 'actor': player.name,
                    'options': offered, 'solo': solo, 'replay': self.get_replay(),
                })
            return super().get_move(player, choice, options)

        def undo(self, invalid=False):
            raise ValueError('Replay contains an invalid or undone action')

    def exhausted(*_):
        raise ValueError('Replay ended early')

    match = RecordingMatch(replay=replay, move_getter=exhausted)
    match.play()
    if match.phase is not Phase.SCORING or match.move_list:
        return []
    active = [rng.choice(groups[False, age]) for age in range(1, 5) if groups[False, age]]
    solo = [rng.choice(groups[True, age]) for age in range(1, 5) if groups[True, age]]
    return active + rng.sample(solo, min(2, len(solo)))


class BudgetReached(Exception):
    pass


def decision_category(prompt, move):
    for prefix, category in (('Undeploy from ', 'undeploy'), ('Deploy to ', 'deploy'),
                             ('Buy P', 'market purchase'), ('Hire', 'hire'),
                             ('Special of ', 'special action'), ('Confirm', 'confirmation')):
        if move.startswith(prefix):
            return category
    if move in ('Pass', 'Turmoil'):
        return move.lower()
    if prompt.startswith('Place '):
        return 'placement choice'
    if prompt == 'Which benefit?':
        return 'benefit choice'
    return prompt if prompt in ('Which action?', 'Complete the turn?') else 'other follow-up'


def measure(root, limit, seconds, merge_undeploys=False, state_pruning=None, worker_transfers=False):
    """Count the root and each distinct path through multi-option prompts.

    Replay each pending path once, following its first child immediately to
    save replays of shared prefixes. Forced prompts are handled within edges.
    """
    pending = [()]
    leaves = Counter()
    resources_seen = defaultdict(list)
    omitted = Counter()
    categories = Counter()
    started, cpu_started = perf_counter(), process_time()
    nodes, max_depth, replay_runs, pruned = 1, 0, 0, 0
    exhausted = None

    def check():
        if perf_counter() - started >= seconds:
            raise BudgetReached('time')

    class BranchMatch(Match):
        def production_phase(self):
            if entered:
                raise SearchBoundary('action phase ended')
            return super().production_phase()

        def undo(self, invalid=False):
            if entered:
                raise SearchBoundary('engine rejected move' if invalid else 'undo')
            raise ValueError('Replay prefix no longer valid')

    def guard_turn(player, take_turn):
        def guarded():
            nonlocal in_turn
            in_turn = True
            try:
                if entered and player.name != root['actor']:
                    raise SearchBoundary('opponent turn')
                return take_turn()
            finally:
                in_turn = False
        return guarded

    def choose(prompt, options, _undo):
        nonlocal entered, route, steps, nodes, max_depth, last_undeploy, pruned
        nonlocal transfer_source
        check()
        offered = tuple(map(str, options))
        if not entered:
            if (match.move_number, match.round_number, match.next_move_player, prompt, offered) != (
                    root['move'], root['round'], root['actor'], 'Which action?', root['options']):
                raise ValueError('Replay prefix did not reproduce the benchmark root')
            lock_hidden_information(match)
            entered = True
        guarded = safe_architect_options(match, prompt, options)
        by_name = {str(option): option for option in guarded if str(option) not in ADMIN}
        transfer_destination = transfer_source is not None and prompt == 'Which action?'
        if len(by_name) == 1 and not transfer_destination:
            last_undeploy = None
            return next(iter(by_name.values()))
        if match.next_move_player != root['actor']:
            raise SearchBoundary('opponent choice')
        if not by_name:
            raise SearchBoundary('no playable choice')
        worker_prompt = prompt in ('Which action?', 'Complete the turn?')
        player = match.current_player
        transfer_sources = set()
        if worker_transfers and worker_prompt and not transfer_destination:
            varanasi_active = any(card.abbr == 'I_Vrn' for card in player.completed_cards())
            waived_upkeep = any(match.events.happen('no military upkeep', player))
            transfer_sources = {move for move, option in by_name.items() if move.startswith(UNDEPLOY)
                                and not standalone_undeploy_allowed(option.card, varanasi_active, waived_upkeep)}
        rank_hooks_inactive = worker_prompt and not any(
            match.events.events[hook].registered_events for hook in UNDEPLOY_RANK_HOOKS)
        moves = list(by_name)
        if transfer_destination:
            moves = [move for move in moves if move.startswith(DEPLOY) and move[len(DEPLOY):] != transfer_source]
            if not moves:
                raise SearchBoundary('no transfer destination')
        elif transfer_sources and prompt == 'Complete the turn?':
            moves = [move for move in moves if move not in transfer_sources]
            if moves == ['Confirm']:
                last_undeploy = None
                return by_name['Confirm']
        elif (transfer_sources and rank_hooks_inactive
              and not match.events.events['deploy discount'].registered_events):
            # An ordinary undeploy leaves Stone and other slots' capacity unchanged.
            destinations = {slot for slot, card in player.filled_slot_names_cards()
                            if card.is_building_military() and player.can_deploy_to_card(card)}
            moves = [move for move in moves if move not in transfer_sources
                     or destinations - {move[len(UNDEPLOY):]}]
        pure_undeploy = merge_undeploys and rank_hooks_inactive
        if steps < len(path):
            selected = path[steps]
            if selected not in moves:
                raise ValueError('Scheduled decision no longer meets the search constraints')
        else:
            # Consecutive pure undeploys change counts and resources additively.
            # Keep one order per multiset, including repeated removals from a slot.
            if pure_undeploy and last_undeploy is not None and prompt == last_undeploy[0]:
                count = len(moves)
                moves = [move for move in moves if (not move.startswith(UNDEPLOY) or move in transfer_sources
                                                    or move >= last_undeploy[1])]
                pruned += count - len(moves)
            if state_pruning and in_turn and prompt in ('Which action?', 'Complete the turn?'):
                key = (transfer_source, decision_key(match, root['actor'], prompt,
                                                     last_undeploy if pure_undeploy else None))
                stock = freeze(player.resources)
                legal = frozenset(moves)
                previous = resources_seen[key]
                for earlier, options_available in previous:
                    if not options_available.issuperset(legal):
                        continue
                    if earlier == stock:
                        omitted['equal'] += 1
                        raise SearchBoundary('merged state')
                    if state_pruning == 'resources' and all(a >= b for a, b in zip(earlier, stock)):
                        omitted['dominated'] += 1
                        raise SearchBoundary('resource dominance')
                previous.append((stock, legal))
            selected, *others = moves
            pending.extend(route + (move,) for move in reversed(others))
        if steps + 1 >= len(path):
            if nodes >= limit:
                raise BudgetReached('nodes')
            nodes += 1
            if transfer_destination:
                categories['transfer destination'] += 1
            elif selected in transfer_sources:
                categories['transfer source'] += 1
            else:
                categories[decision_category(prompt, selected)] += 1
        steps += 1
        route += (selected,)
        max_depth = max(max_depth, steps)
        last_undeploy = ((prompt, selected) if pure_undeploy and selected.startswith(UNDEPLOY)
                         and selected not in transfer_sources else None)
        if transfer_destination:
            transfer_source = None
        elif selected in transfer_sources:
            transfer_source = selected[len(UNDEPLOY):]
        return by_name[selected]

    while pending:
        try:
            check()
            path = pending.pop()
            entered, route, steps, last_undeploy, in_turn = False, (), 0, None, False
            transfer_source = None
            replay_runs += 1
            match = BranchMatch(replay=root['replay'], move_getter=choose)
            for player in match.players:
                player.take_turn = guard_turn(player, player.take_turn)
            try:
                match.play()
            except SearchBoundary as boundary:
                if steps < len(path):
                    raise ValueError('Scheduled branch did not reproduce its decision path') from boundary
                leaves[str(boundary)] += 1
            else:
                raise ValueError('Engine ended without hitting a handoff boundary')
        except BudgetReached as budget:
            exhausted = str(budget)
            break

    return {**{k: root[k] for k in ('game', 'players', 'round', 'move', 'solo')},
            'root_choices': len(set(root['options']) - ADMIN), 'nodes': nodes,
            'minimum_nodes': nodes + len(pending), 'pending': len(pending), 'max_depth': max_depth,
            'replays': replay_runs, 'leaves': dict(leaves), 'budget': exhausted,
            'merge_undeploys': merge_undeploys, 'pruned_edges': pruned,
            'state_pruning': state_pruning, 'pruned_states': dict(omitted),
            'worker_transfers': worker_transfers,
            'node_actions': dict(categories),
            'wall_ms': round((perf_counter() - started) * 1000, 2),
            'cpu_ms': round((process_time() - cpu_started) * 1000, 2)}


def load_sample(archive_path, per_count, seed):
    rng = Random(seed)
    candidates = defaultdict(list)
    with tarfile.open(archive_path) as archive:
        for member in archive:
            if not member.isfile() or not member.name.endswith('.replay'):
                continue
            replay = archive.extractfile(member).read().decode('utf-8').replace('\r\n', '\n')
            header, _, moves = replay.partition('\n\n')
            players = [line[7:] for line in header.splitlines() if line.startswith('player ')]
            if len(players) in range(2, 6) and not any(p.lower().startswith('nationsbot') for p in players):
                if 'UNDO' not in moves.splitlines():
                    candidates[len(players)].append((member.name, replay))
    roots, accepted = [], Counter()
    for count in sorted(candidates):
        entries = sorted(candidates[count])
        rng.shuffle(entries)
        for name, replay in entries:
            try:
                positions = sampled_roots(replay, rng)
            except (ValueError, KeyError, IndexError) as error:
                print(f'Skipped {name}: {type(error).__name__}', file=sys.stderr)
                continue
            if positions:
                accepted[count] += 1
                roots.extend(dict(position, game=Path(name).stem, players=count) for position in positions)
            if accepted[count] >= per_count:
                break
    return roots, dict(accepted)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--per-count', type=int, default=6)
    parser.add_argument('--seed', type=int, default=142)
    parser.add_argument('--nodes', type=int, default=1000)
    parser.add_argument('--seconds', type=float, default=15)
    parser.add_argument('--shards', type=int, default=1)
    parser.add_argument('--shard', type=int, default=0)
    parser.add_argument('--positions', nargs='*', metavar='GAME:MOVE')
    parser.add_argument('--merge-undeploys', action='store_true', help='Merge consecutive undeploy orders when rank hooks are inactive.')
    parser.add_argument('--state-pruning', choices=('equal', 'resources'),
                        help='Merge equal turn states, optionally pruning resource-dominated states.')
    parser.add_argument('--worker-transfers', action='store_true',
                        help='Require a transfer unless the worker has an active penalty or Varanasi rewards leaving it idle.')
    args = parser.parse_args()
    if not 0 <= args.shard < args.shards or args.nodes < 2 or args.seconds <= 0 or args.per_count < 1:
        parser.error('Expected a valid shard, at least two nodes, and positive time and sample size')
    roots, games = load_sample(args.archive, args.per_count, args.seed)
    if args.positions:
        roots = [r for r in roots if f"{r['game']}:{r['move']}" in args.positions]
    roots = roots[args.shard::args.shards]
    print(f'Measuring {len(roots)} positions from sampled games {games}', flush=True)
    rows = []
    with args.output.open('w', encoding='utf-8') as file:
        for root in roots:
            row = measure(root, args.nodes, args.seconds, args.merge_undeploys, args.state_pruning,
                          args.worker_transfers)
            rows.append(row)
            file.write(json.dumps(row) + '\n')
            file.flush()
    print(f"Completed {sum(row['budget'] is None for row in rows)}/{len(rows)} trees", flush=True)


if __name__ == '__main__':
    main()
