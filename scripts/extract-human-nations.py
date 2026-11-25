"""Reconstruct public decision positions from a Tabony replay archive."""

from nations_action_prompt import policy_prompt
import argparse
from collections import Counter
from contextlib import ExitStack
import gzip
from hashlib import sha256
import json
from pathlib import Path
import re
import sys
import tarfile


ROOT = Path(__file__).resolve().parents[1]
PHASES = {'Draft which nation?': 'draft', 'Take what for growth?': 'growth', 'Which action?': 'action',
          'Which benefit?': 'benefit', 'Play which dynasty?': 'dynasty'}
EXCLUDED = {'UNDO', 'Resign', 'Confirm', 'Confirm and complete the turn now'}


def read_decisions(match_type, replay):
    class RecordingMatch(match_type):
        def get_move(self, player, choice, options):
            legal = [str(option) for option in options if str(option) not in EXCLUDED]
            recorded = self.move_list[0] if self.move_list else None
            phase = PHASES.get(policy_prompt(choice))
            if (phase and self.replaying_invalid_or_undo == 0
                    and recorded in legal and len(legal) > 1):
                snapshot = self.get_state()
                order = [seats[name] for name in snapshot['player_order']]
                positions.append((phase, seats[player.name], recorded, {
                    'round': self.round_number, 'move_number': self.move_number,
                    'next_move_choice': choice, 'next_move_player': seats[player.name], 'next_move_options': legal,
                    'player_order': order,
                    'first_round_player_order': [seats[name] for name in snapshot['first_round_player_order']],
                    'players': {seats[name]: {key: p[key] for key in (
                        'nation', 'resources', 'production', 'workers', 'grown_workers', 'slots', 'cards',
                        'dynasties', 'points', 'passed', 'score') if key in p} for name, p in snapshot['players'].items()},
                    **{key: snapshot[key] for key in ('nations', 'progress_board', 'event', 'war', 'war_value', 'architects', 'turmoil')},
                }))
            return super().get_move(player, choice, options)

        def undo(self, invalid=False):
            raise ValueError('Replay attempted to undo an action')

    def exhausted(*_):
        raise ValueError('Replay ended before scoring')

    positions = []
    match = RecordingMatch(replay=replay, move_getter=exhausted)
    seats = {p.name: f'Seat{i}' for i, p in enumerate(match.initial_player_order)}
    match.play()
    if match.move_list or not match.game_over:
        raise ValueError('Replay did not consume its recorded moves')
    if match.phase.name != 'SCORING' or match.round_number != 8:
        return None
    placements = sorted(match.players, key=lambda player: (
        -player.score(), -player.resource_remainder() if match.resource_remainder_tiebreaker else 0))
    ranks = {seats[player.name]: rank for rank, player in enumerate(placements, 1)}
    dynasty_games = []
    log = match.get_log()
    for player in match.players:
        plays = re.findall(r'^' + re.escape(player.name) + r' plays "([^"]+)"\.$', log, re.M)
        dynasty_games.append({'nation': player.nation.name, 'plays': plays})
    return positions, ranks, dynasty_games


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--engine', type=Path, default=ROOT.parent / 'nations-server/Nations')
    parser.add_argument('--limit', type=int, help='Only process this many archive entries for a smoke check.')
    args = parser.parse_args()
    sys.path.insert(0, str(args.engine.resolve()))
    from nations import Match

    args.output.mkdir(parents=True, exist_ok=False)
    games = Counter()
    decisions = Counter()
    skipped = Counter()
    failures = []
    seen = set()
    dynasty_stats = {}
    with tarfile.open(args.archive, 'r:gz') as archive, ExitStack() as stack:
        streams = {split: stack.enter_context(gzip.open(args.output / f'{split}.jsonl.gz', 'wt', encoding='utf-8', compresslevel=2))
                   for split in ('train', 'validation', 'test')}
        for i, member in enumerate(archive):
            if args.limit is not None and i >= args.limit:
                break
            identifier = re.fullmatch(r'match(\d+)\.replay', Path(member.name).name)
            if not member.isfile() or not identifier or member.size > 2_000_000:
                skipped['unsupported archive entry'] += 1
                continue
            file = archive.extractfile(member)
            with file:
                replay = file.read().decode('utf-8').replace('\r\n', '\n')
            header, _, moves = replay.partition('\n\n')
            names = re.findall(r'^player (.+)$', header, re.M)
            if len(names) not in (2, 4):
                skipped['other player count'] += 1
                continue
            if any(re.fullmatch(r'NationsBot\d*', name, re.I) for name in names):
                skipped['known bot account'] += 1
                continue
            if 'UNDO' in moves.splitlines():
                skipped['replay contains undo'] += 1
                continue
            digest = sha256(replay.encode()).hexdigest()
            if digest in seen:
                skipped['duplicate replay'] += 1
                continue
            seen.add(digest)
            seed = re.search(r'^seed ([a-fA-F0-9]+)$', header, re.M)
            if not seed:
                skipped['missing seed'] += 1
                continue
            # Every position from a game stays together. Group shared seeds as
            # well, so identical openings cannot straddle different splits.
            bucket = int(sha256(bytes.fromhex(seed[1].zfill(len(seed[1]) + len(seed[1]) % 2))).hexdigest()[:8], 16) % 100
            split = 'train' if bucket < 80 else 'validation' if bucket < 90 else 'test'
            try:
                result = read_decisions(Match, replay)
            except Exception as error:
                failures.append({'match': int(identifier[1]), 'error_type': type(error).__name__})
                continue
            if result is None:
                skipped['did not reach final scoring'] += 1
                continue
            positions, ranks, dynasty_games = result
            for game in dynasty_games:
                stats = dynasty_stats.setdefault(game['nation'], {'games': 0, 'kept_default': 0, 'first_play': Counter(), 'ever_played': Counter()})
                stats['games'] += 1
                stats['kept_default'] += not game['plays']
                if game['plays']:
                    stats['first_play'][game['plays'][0]] += 1
                    stats['ever_played'].update(set(game['plays']))
            games[f'{split}/{len(names)}p'] += 1
            for phase, seat, chosen, state in positions:
                row = {'match': int(identifier[1]), 'phase': phase, 'rank': ranks[seat], 'chosen': chosen, 'state': state}
                streams[split].write(json.dumps(row, separators=(',', ':')) + '\n')
                decisions[f'{split}/{len(names)}p/{phase}'] += 1
    report = {'archive': args.archive.name, 'sha256': sha256(args.archive.read_bytes()).hexdigest(),
              'games': dict(games), 'decisions': dict(decisions), 'skipped': dict(skipped), 'failures': failures}
    (args.output / 'corpus.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    (args.output / 'dynasty-statistics.json').write_text(json.dumps(dynasty_stats, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
