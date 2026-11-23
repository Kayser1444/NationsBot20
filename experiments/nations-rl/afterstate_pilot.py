"""Train one state-value network on greedy one-action self-play."""
import argparse
from collections import Counter
from contextlib import ExitStack
import json
from pathlib import Path
import random
import subprocess
import sys
from time import perf_counter

import numpy as np
import torch
from torch import nn

from compare_position_encoding import LegacyInput, StaticFallback, card_catalog, load_structured
from continue_position_selfplay import close_worker
from encoding import BUCKETS, legal_moves
from model import PolicyValue, load_model
from position_encoding import PositionEncoder
from train import ROOT, RULES, board_seed, digest, emit, play_game, seed_all, summarize, write_json


SCHEMA = 'one-action-value-v1'
NAMES = ('Seat0', 'Seat1')


class AfterstateValue(nn.Module):
    def __init__(self, state_size):
        super().__init__()
        self.state_size = state_size
        self.state_embedding = nn.Embedding(BUCKETS, 24, padding_idx=0)
        self.context = nn.Sequential(nn.Linear(state_size + 24, 64), nn.Tanh())
        self.value = nn.Sequential(nn.Linear(64, 32), nn.Tanh(), nn.Linear(32, 1))

    def forward(self, numbers, tokens):
        encoded = self.context(torch.cat((numbers, PolicyValue.pool(self.state_embedding, tokens)), -1))
        return self.value(encoded).squeeze(-1)


@torch.no_grad()
def initialize(prior):
    model = AfterstateValue(prior.config['state_size'] + 1)
    model.state_embedding.load_state_dict(prior.state_embedding.state_dict())
    model.value.load_state_dict(prior.value.state_dict())
    old, new = prior.context[0], model.context[0]
    size = prior.config['state_size']
    new.weight.zero_()
    new.weight[:, :size] = old.weight[:, :size]
    new.weight[:, -24:] = old.weight[:, -24:]
    new.bias.copy_(old.bias)
    return model


def save(path, model, games, optimizer, history=()):
    temporary = path.with_suffix('.tmp')
    torch.save({'schema': SCHEMA, 'state_size': model.state_size, 'games': games,
                'value': model.state_dict(), 'optimizer': optimizer.state_dict(),
                'history': list(history)}, temporary)
    temporary.replace(path)


def load(path):
    checkpoint = torch.load(path, weights_only=True, map_location='cpu')
    if checkpoint['schema'] != SCHEMA:
        raise ValueError('Unexpected afterstate schema')
    model = AfterstateValue(checkpoint['state_size'])
    model.load_state_dict(checkpoint['value'])
    return model.eval(), checkpoint


def tensors(rows):
    numbers = torch.from_numpy(np.stack([r[0] for r in rows]))
    tokens = torch.from_numpy(np.stack([r[1] for r in rows])).long()
    return numbers, tokens


def afterstate_features(encoder, state, actions_left):
    numbers, tokens = encoder.state(state | {'next_move_choice': 'Which action?', 'next_move_options': ()})
    return np.append(numbers, np.float32(actions_left > 0)), tokens


class GreedyValuePlayer:
    def __init__(self, model, encoder, fallback, seats, evaluate_action):
        self.model, self.encoder, self.fallback = model, encoder, fallback
        self.seats, self.evaluate_action = seats, evaluate_action
        self.plan = ()
        self.trajectory = []
        self.counts = Counter()
        self.acted = set()

    def followup(self, branch, legal):
        from nations_move_safety import with_move_options

        return legal[0] if len(legal) == 1 else self.fallback.choose(with_move_options(branch.get_state(), legal))

    @torch.inference_mode()
    def choose(self, match, state, options):
        if self.plan:
            who, move = self.plan[0]
            if who != state['next_move_player'] or move not in state['next_move_options']:
                raise ValueError('Engine did not reproduce the chosen action follow-up')
            self.plan = self.plan[1:]
            return move
        actor = state['next_move_player']
        if (actor not in self.seats or state['next_move_choice'] != 'Which action?'
                or match.phase.name != 'ACTION' or len(legal_moves(state)) < 2):
            return None
        actions = [option for option in options if str(option) in legal_moves(state)]
        choices = [(action, self.evaluate_action(match, action, self.followup)) for action in actions]
        candidates = [(action, position) for action, position in choices if not isinstance(position, str)]
        self.counts.update(actions=len(actions), unknown=len(actions) - len(candidates))
        if len(candidates) != len(choices):
            self.counts['fallback_prompts'] += 1
            return None
        features = [afterstate_features(self.encoder, position.state, position.actions_left)
                    for _, position in candidates]
        scores = self.model(*tensors(features))
        choice = scores.argmax().item()
        action, position = candidates[choice]
        turn = (actor, state['round'])
        passed = str(action) == 'Pass'
        if turn not in self.acted:
            self.acted.add(turn)
            self.counts['first_choices'] += 1
            self.counts['first_choice_passes'] += passed
        self.counts['chosen'] += 1
        self.plan = position.choices
        self.trajectory.append((actor, *features[choice]))
        return str(action)


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def replay_samples(match_type, encoder, paths):
    from nations.actions import ActionType
    from nations.player import Player

    samples, targets = [], []
    original = Player.take_action
    trajectory = []

    def record(actor, action):
        match = actor.match
        should_record = (match.phase.name == 'ACTION' and match.next_move_choice == 'Which action?'
                         and match.next_move_player == actor.name)
        original(actor, action)
        if should_record:
            left = 0 if action.action_type is ActionType.PASS else (
                actor.remaining_main_actions - int(action.action_type is not ActionType.UNDEPLOY))
            state = match.get_state() | {'next_move_player': actor.name}
            trajectory.append((actor.name, *afterstate_features(encoder, state, left)))

    def exhausted(*_):
        raise ValueError('Recorded match ended before final scoring')

    Player.take_action = record
    try:
        for name in paths:
            trajectory.clear()
            game = match_type(replay=Path(name).read_text(encoding='utf-8'), move_getter=exhausted)
            game.play()
            if not game.game_over or game.round_number != 8:
                raise ValueError(f'Incomplete replay {name}')
            winner = min(game.players, key=lambda p: (-p.score(), -p.resource_remainder()
                         if game.resource_remainder_tiebreaker else 0)).name
            samples.extend((numbers, tokens) for _, numbers, tokens in trajectory)
            targets.extend(float(actor == winner) for actor, *_ in trajectory)
    finally:
        Player.take_action = original
    return samples, targets


def save_samples(path, features, targets):
    numbers, tokens = tensors(features)
    np.savez(path.with_suffix('.npz'), numbers=numbers.numpy(), tokens=tokens.numpy(),
             targets=np.asarray(targets, dtype=np.float32))


def worker(path, persistent=False):
    work = read(path)
    batch = Path(work['batch'])
    sys.path[:0] = [str(batch/'snapshot/engine'), str(ROOT/'scripts')]
    from nations import Match

    seed_all(work['seed'], 1)
    encoder = PositionEncoder(card_catalog(batch))
    if work.get('replays'):
        features, targets = replay_samples(Match, encoder, work['replays'])
        save_samples(path, features, targets)
        return
    anchor = load_structured(Path(work['anchor']))
    benchmark = LegacyInput(load_model(Path(work['benchmark']))[0].eval())
    fallback = StaticFallback(batch)
    try:
        if persistent:
            for line in sys.stdin:
                job = Path(json.loads(line)['job'])
                play_jobs(job, Match, encoder, anchor, benchmark, fallback, Path(work['checkpoint']), read(job)['games'])
                emit({'job': str(job)})
        else:
            play_jobs(path, Match, encoder, anchor, benchmark, fallback, Path(work['checkpoint']), work['games'])
    finally:
        fallback.close()


def play_jobs(path, match_type, encoder, anchor, benchmark, fallback, checkpoint, games):
    from one_step_position import evaluate_action

    model, _ = load(checkpoint)
    rows, features, targets = [], [], []
    for seed, seat in games:
        seats = NAMES if seat is None else (NAMES[seat],)
        player = GreedyValuePlayer(model, encoder, fallback, seats, evaluate_action)
        policies = {name: anchor if name in seats else benchmark for name in NAMES}
        replay = path.parent / f'{path.stem}-{seed[:16]}-{seat}.replay'
        row, _ = play_game(match_type, encoder, fallback, policies, (), seed, replay if seat is not None else None,
                           sample=False, sampling_seed=0, seconds=120,
                           failure_output=replay, move_override=player.choose)
        rows.append(row | {'afterstate_counts': dict(player.counts)}
                    | ({} if seat is None else {'candidate': seats[0], 'opponent': NAMES[1 - seat]}))
        if seat is None and not row['error']:
            features.extend((numbers, tokens) for _, numbers, tokens in player.trajectory)
            targets.extend(row['rewards'][name] for name, *_ in player.trajectory)
    write_json(path.with_suffix('.results.json'), rows)
    if features:
        save_samples(path, features, targets)


def run_workers(args, directory, shared, field, items):
    directory.mkdir(exist_ok=True)
    running = []
    for index in range(min(args.workers, len(items))):
        path = directory / f'worker-{index:02}.json'
        write_json(path, {'batch': str(args.batch), 'seed': args.seed, **shared,
                          field: items[index::args.workers]})
        with path.with_suffix('.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '--worker', str(path)],
                                       stdout=log, stderr=subprocess.STDOUT)
        running.append((process, path))
    failures = [path for process, path in running if process.wait()]
    if failures:
        raise RuntimeError(f'Afterstate workers failed; review {failures[0].with_suffix(".log")}')
    return [path for _, path in running]


def games_for(args, checkpoint, anchor, benchmark, directory, games):
    files = run_workers(args, directory, {'anchor': str(anchor), 'benchmark': str(benchmark),
                                          'checkpoint': str(checkpoint)}, 'games', games)
    return read_games(files, games)


def read_games(files, games):
    rows = [r for path in files for r in read(path.with_suffix('.results.json'))]
    if len(rows) != len(games):
        raise RuntimeError('Incomplete batch')
    return rows, [path.with_suffix('.npz') for path in files if path.with_suffix('.npz').exists()]


def start_game_workers(args, checkpoint, anchor, benchmark, stack):
    settings = args.output / 'workers.json'
    write_json(settings, {'batch': str(args.batch), 'seed': args.seed, 'anchor': str(anchor),
                          'benchmark': str(benchmark), 'checkpoint': str(checkpoint)})
    pool = []
    for index in range(args.workers):
        log_path = args.output / f'worker-{index:02}.log'
        with log_path.open('a', encoding='utf-8') as log:
            child = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()),
                                      '--persistent-worker', str(settings)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8', bufsize=1)
        stack.callback(close_worker, child)
        pool.append((child, log_path))
    return pool


def ask_game_workers(pool, directory, games):
    directory.mkdir(exist_ok=True)
    assigned = []
    for index, (child, log) in enumerate(pool[:len(games)]):
        job = directory / f'worker-{index:02}.json'
        write_json(job, {'games': games[index::len(pool)]})
        child.stdin.write(json.dumps({'job': str(job)}) + '\n')
        child.stdin.flush()
        assigned.append((child, log, job))
    for child, log, job in assigned:
        line = child.stdout.readline()
        if not line or json.loads(line)['job'] != str(job):
            raise RuntimeError(f'Afterstate worker did not finish {job}; see {log}')
    return read_games([job for _, _, job in assigned], games)


def fit(model, optimizer, files, seed):
    with_arrays = {'numbers': [], 'tokens': [], 'targets': []}
    for path in files:
        with np.load(path, allow_pickle=False) as arrays:
            for key in with_arrays:
                with_arrays[key].append(arrays[key])
    numbers, tokens, targets = (torch.from_numpy(np.concatenate(data)) for data in with_arrays.values())
    order = torch.randperm(len(targets), generator=torch.Generator().manual_seed(seed))
    total = 0.0
    model.train()
    for indices in order.split(256):
        residual = nn.functional.binary_cross_entropy_with_logits(model(numbers[indices], tokens[indices]), targets[indices])
        optimizer.zero_grad()
        residual.backward()
        optimizer.step()
        total += residual.item() * len(indices)
    return {'samples': len(targets), 'value_loss': total / len(targets)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch', type=Path, default=ROOT/'.data/nations-rl/batch-10000-v1')
    parser.add_argument('--scale-run', type=Path, default=ROOT/'.data/nations-rl/current-position-scale-v1')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--games', type=int, default=48)
    parser.add_argument('--games-per-update', type=int, default=48)
    parser.add_argument('--boards', type=int, default=12)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--seed', type=int, default=181146)
    parser.add_argument('--evaluation-seed', type=int, help='Reuse evaluation boards with a separate training seed.')
    parser.add_argument('--training-minutes', type=float, help='Stop at the first saved update after this training time.')
    parser.add_argument('--bootstrap-replays', type=int, default=0)
    parser.add_argument('--bootstrap-epochs', type=int, default=3)
    parser.add_argument('--initial', type=Path)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if min(args.games, args.games_per_update, args.boards, args.workers, args.bootstrap_epochs) < 1 or args.bootstrap_replays < 0:
        parser.error('Use positive counts')
    if args.training_minutes is not None and not (0 < args.training_minutes < float('inf')):
        parser.error('Training minutes must be finite and positive')
    training_limit = args.training_minutes * 60 if args.training_minutes is not None else float('inf')
    evaluation_seed = args.seed if args.evaluation_seed is None else args.evaluation_seed
    args.batch, args.output = args.batch.resolve(), args.output.resolve()
    anchor = Path(next(record['checkpoint'] for record in read(args.scale_run/'monitoring.json')
                       if record['games'] == 6000))
    benchmark = args.batch / read(args.batch/'selection.json')['selected']
    if read(args.batch/'manifest.json')['rules'] != RULES:
        raise ValueError('Benchmark rules differ from training rules')
    if args.initial and args.bootstrap_replays:
        parser.error('Choose either a starting checkpoint or replay warm-up')
    manifest = {'games': args.games, 'games_per_update': args.games_per_update, 'boards': args.boards,
                'seed': args.seed, 'anchor': digest(anchor), 'benchmark': digest(benchmark), 'schema': SCHEMA,
                'initial': digest(args.initial) if args.initial else None,
                'bootstrap_replays': args.bootstrap_replays, 'bootstrap_epochs': args.bootstrap_epochs}
    if args.training_minutes is not None:
        manifest['training_minutes'] = args.training_minutes
    if args.evaluation_seed is not None:
        manifest['evaluation_seed'] = evaluation_seed
    seed_all(args.seed, min(4, args.workers))
    checkpoint = args.output/'value.pt'
    if args.resume:
        if read(args.output/'manifest.json') != manifest or (args.output/'results.json').is_file():
            raise ValueError('Resume requires the same inputs and an unfinished run')
    else:
        args.output.mkdir(parents=True)
        write_json(args.output/'manifest.json', manifest)
    source = checkpoint if args.resume else args.initial
    history = []
    if source is None:
        model, games = initialize(load_structured(anchor)), 0
        optimizer = torch.optim.Adam(model.parameters(), lr=.0001)
    else:
        model, saved = load(source)
        games = saved['games']
        history = saved.get('history', []) if args.resume else []
        optimizer = torch.optim.Adam(model.parameters(), lr=.0001)
        optimizer.load_state_dict(saved['optimizer'])
    if games > args.games:
        raise ValueError('Starting checkpoint exceeded the requested training total')
    if not args.resume:
        save(checkpoint, model, games, optimizer, history)
    heldout = [(board_seed('afterstate-heldout', evaluation_seed, board), seat)
               for board in range(args.boards) for seat in range(2)]
    first = perf_counter()
    if args.bootstrap_replays and not (args.output/'bootstrap.json').exists():
        source = ROOT / '.data/nations-rl/current-position-256-boards-v1/replays'
        available = sorted(source.glob('6000-vs-benchmark-*.replay'))
        paths = random.Random(args.seed).sample(available, args.bootstrap_replays)
        files = run_workers(args, args.output/'bootstrap', {}, 'replays', [str(path) for path in paths])
        arrays = [path.with_suffix('.npz') for path in files]
        records = [fit(model, optimizer, arrays, args.seed + epoch) for epoch in range(args.bootstrap_epochs)]
        save(checkpoint, model, 0, optimizer)
        write_json(args.output/'bootstrap.json', {'epochs': records, 'replays': [p.name for p in paths]})
        emit({'stage': 'bootstrap', 'replays': len(paths), 'epochs': records})
        for path in arrays:
            path.unlink()
    before = args.output/'before.json'
    if before.exists():
        start = read(before)
    else:
        start, _ = games_for(args, checkpoint, anchor, benchmark, args.output/'before', heldout)
        write_json(before, start)
        emit({'stage': 'before', **summarize(start)})
    attempted = history[-1]['attempted'] if history else 0
    training_seconds = history[-1].get('training_seconds', 0) if history else 0
    with ExitStack() as stack:
        pool = (start_game_workers(args, checkpoint, anchor, benchmark, stack)
                if games < args.games and training_seconds < training_limit else [])
        while games < args.games and training_seconds < training_limit:
            count = min(args.games_per_update, args.games - games)
            remaining, wave = count, 0
            files, failures = [], Counter()
            observations = Counter()
            started = perf_counter()
            directory = args.output/f'train-{games + count:05}'
            directory.mkdir(exist_ok=True)
            while remaining:
                work = [(board_seed('afterstate-selfplay', args.seed, board), None)
                        for board in range(attempted, attempted + remaining)]
                rows, arrays = ask_game_workers(pool, directory/f'wave-{wave:02}', work)
                files.extend(arrays)
                rejected = [r['error'] for r in rows if r['error']]
                if len(rejected) == remaining:
                    raise RuntimeError(f'Every greedy game failed; review the replays in {directory}')
                for result in rows:
                    if not result['error']:
                        observations.update(result['afterstate_counts'])
                failures.update(rejected)
                attempted += remaining
                remaining = len(rejected)
                wave += 1
            games += count
            record = {'attempted': attempted, 'completed': count, 'total_games': games,
                      'failures': dict(failures), 'collection_seconds': round(perf_counter() - started, 2),
                      'counts': dict(observations)}
            record.update(fit(model, optimizer, files, args.seed + attempted))
            training_seconds += perf_counter() - started
            record['training_seconds'] = round(training_seconds, 2)
            history.append(record)
            save(checkpoint, model, games, optimizer, history)
            write_json(args.output/'training.json', history)
            emit({'stage': 'training', **record})
            for path in files:
                path.unlink()
    finish, _ = games_for(args, checkpoint, anchor, benchmark, args.output/'after', heldout)
    result = {'games': games, 'training': history, 'before': summarize(start), 'after': summarize(finish),
              'training_seconds': round(training_seconds, 2),
              'stop_reason': 'training time reached' if training_seconds >= training_limit else 'game target reached',
              'seconds': round(perf_counter() - first, 2)}
    write_json(args.output/'results.json', result)
    emit({'stage': 'complete', **result})


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] in ('--worker', '--persistent-worker'):
        worker(Path(sys.argv[2]), persistent=sys.argv[1] == '--persistent-worker')
    else:
        main()
