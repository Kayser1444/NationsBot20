"""Offline two-player imitation/value pretraining and bounded PPO self-play.

This entry point never installs or selects a model in the hosted player. Every
run owns a new directory, snapshots its dependencies and records its provenance.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tarfile
import time

import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical

from encoding import Encoder, SUPPORTED, legal_moves
from model import PolicyValue, collate, save_model, load_model, initialize_four_player

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RULES = dict(growth_resources=2, extra_draft_nations=1, resource_remainder_tiebreaker=True,
             card_draw_limits=True, korea_nerf=True, lincoln_nerf=True)
CONFIRMATIONS = ('Confirm', 'Confirm and complete the turn now')
LEAGUE_POINTS = (5, 3, 2, 1)


def value_target(rank, count):
    return float(rank == 1) if count == 2 else (LEAGUE_POINTS[rank - 1] - 1) / 4


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(path)


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def seed_all(seed, threads):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(threads)
    torch.use_deterministic_algorithms(True)


def snapshot(output, engine):
    output.mkdir(parents=True, exist_ok=False)
    target = output / 'snapshot'
    hashes = {}
    for source, destination, patterns in (
        (ROOT / 'live-player', target / 'baseline', ('*.mjs', '*.json')),
        (engine, target / 'engine' / 'nations', ('*.py', 'LICENSE')),
        (HERE, target / 'experiment', ('*.py', '*.mjs', '*.txt')),
    ):
        destination.mkdir(parents=True)
        for pattern in patterns:
            for path in sorted(source.glob(pattern)):
                if path.is_file():
                    shutil.copy2(path, destination / path.name)
                    hashes[(destination / path.name).relative_to(output).as_posix()] = digest(destination / path.name)
    manifest = {'created_utc': datetime.now(timezone.utc).isoformat(), 'rules': RULES,
                'repository_root': str(ROOT),
                'torch': str(torch.__version__), 'numpy': np.__version__, 'python': sys.version,
                'source_sha256': hashes}
    write_json(output / 'manifest.json', manifest)
    return manifest


def verify_snapshot(run, runtime_sources=('train.py', 'model.py', 'encoding.py', 'baseline-bridge.mjs')):
    manifest = json.loads((run / 'manifest.json').read_text(encoding='utf-8'))
    hashes = {name.replace('\\', '/'): value for name, value in manifest['source_sha256'].items()}
    for name, expected in hashes.items():
        if digest(run / name) != expected:
            raise ValueError(f'Snapshot changed: {name}')
    for name in runtime_sources:
        key = 'snapshot/experiment/' + name
        if digest(HERE / name) != hashes[key]:
            raise ValueError(f'Experiment source changed; invoke {run / "snapshot/experiment/train.py"} instead')
    return manifest


def read_corpus(path, encoder, limit, rng):
    rows, seen, games, phases = [], 0, set(), Counter()
    with gzip.open(path, 'rt', encoding='utf-8') as source:
        for line in source:
            record = json.loads(line)
            state = record['state']
            if len(state.get('players', {})) != encoder.player_count or state['next_move_choice'] not in SUPPORTED:
                continue
            if record['rank'] not in range(1, encoder.player_count + 1):
                raise ValueError('Invalid placement label')
            games.add(record['match'])
            phases[record['phase']] += 1
            seen += 1
            # Uniform reservoir sampling is independent of labels and outcomes.
            index = seen - 1 if len(rows) < limit else rng.randrange(seen)
            if index >= limit:
                continue
            features, moves = encoder.encode(state)
            if record['chosen'] not in moves:
                raise ValueError(f'Human choice is not legal in match {record["match"]}')
            features.update(label=moves.index(record['chosen']), target=value_target(record['rank'], encoder.player_count),
                            game=record['match'], phase=record['phase'])
            if index < len(rows):
                rows[index] = features
            else:
                rows.append(features)
    if not rows:
        raise ValueError(f'No usable {encoder.player_count}-player decisions in {path}')
    return rows, games, {'available_decisions': seen, 'sampled_decisions': len(rows),
                         'available_games': len(games), 'sampled_games': len({r['game'] for r in rows}),
                         'available_phases': dict(phases), 'sampled_phases': dict(Counter(r['phase'] for r in rows))}


def audit_archive(archive_path, corpus, identities):
    """Check seed-grouped splits against the original archive, outside the encoder."""
    if digest(archive_path) != corpus['sha256']:
        raise ValueError('Archive hash does not match corpus provenance')
    seed_sets = {split: set() for split in identities}
    found = set()
    with tarfile.open(archive_path, 'r:gz') as archive:
        for member in archive:
            name = Path(member.name).name
            if not member.isfile() or not name.startswith('match') or not name.endswith('.replay'):
                continue
            identifier = name[5:-7]
            if not identifier.isdigit():
                continue
            game = int(identifier)
            split = next((s for s, games in identities.items() if game in games), None)
            if split is None:
                continue
            with archive.extractfile(member) as stream:
                header = stream.read(2_000_001).decode('utf-8').replace('\r\n', '\n').split('\n\n')[0]
            raw_seed = next((line[5:] for line in header.splitlines() if line.startswith('seed ')), None)
            if raw_seed is None:
                raise ValueError(f'Missing seed for corpus match {game}')
            normalized = bytes.fromhex(raw_seed.zfill(len(raw_seed) + len(raw_seed) % 2))
            seed_sets[split].add(hashlib.sha256(normalized).hexdigest())
            found.add(game)
    if found != set.union(*identities.values()):
        raise ValueError('Not all corpus matches were found in the original archive')
    if any(seed_sets[a] & seed_sets[b] for a, b in (('train', 'validation'), ('train', 'test'), ('validation', 'test'))):
        raise ValueError('A starting seed appears in multiple corpus splits')
    return {'archive_sha256': digest(archive_path), 'seed_hashes': {s: sorted(v) for s, v in seed_sets.items()},
            'seed_groups_disjoint': True}


@torch.inference_mode()
def evaluate_predictions(model, rows, batch_size=256):
    model.eval()
    totals, game_values = Counter(), defaultdict(list)
    for start in range(0, len(rows), batch_size):
        part = rows[start:start + batch_size]
        logits, value = model(collate(part))
        labels = torch.tensor([r['label'] for r in part])
        targets = torch.tensor([r['target'] for r in part])
        probs = value.sigmoid()
        totals['policy_nll'] += nn.functional.cross_entropy(logits, labels, reduction='sum').item()
        totals['value_bce'] += nn.functional.binary_cross_entropy_with_logits(value, targets, reduction='sum').item()
        totals['value_brier'] += (probs - targets).square().sum().item()
        totals['policy_top1'] += logits.argmax(-1).eq(labels).sum().item()
        totals['policy_top3'] += logits.topk(min(3, logits.shape[1]), -1).indices.eq(labels[:, None]).any(-1).sum().item()
        totals['random_top1'] += sum(1 / len(r['an']) for r in part)
        for row, probability in zip(part, probs.tolist()):
            game_values[row['game']].append((probability - row['target']) ** 2)
    metrics = {key: value / len(rows) for key, value in totals.items()}
    metrics.update(decisions=len(rows), games=len(game_values),
                   value_brier_game_mean=float(np.mean([np.mean(v) for v in game_values.values()])))
    if model.config.get('player_count') == 4:
        metrics['constant_equal_placement_brier'] = float(np.mean([(r['target'] - .4375) ** 2 for r in rows]))
    else:
        metrics['constant_half_brier'] = .25
    return metrics


def pretrain(args):
    started = time.monotonic()
    manifest = snapshot(args.output, args.engine)
    encoder = Encoder(json.loads((args.output / 'snapshot/baseline/card-index.json').read_text(encoding='utf-8')), args.players)
    source = args.corpus.resolve()
    datasets, identities, statistics = {}, {}, {}
    for split, limit in (('train', args.max_train), ('validation', args.max_eval), ('test', args.max_eval)):
        datasets[split], identities[split], statistics[split] = read_corpus(
            source / f'{split}.jsonl.gz', encoder, limit, random.Random(args.seed + len(datasets)))
        emit({'stage': 'corpus', 'split': split, **statistics[split]})
    if any(identities[a] & identities[b] for a, b in (('train', 'validation'), ('train', 'test'), ('validation', 'test'))):
        raise ValueError('A replay appears in multiple corpus splits')
    corpus = json.loads((source / 'corpus.json').read_text(encoding='utf-8'))
    manifest.update(arguments={k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
                    corpus=corpus, corpus_sha256={p.name: digest(p) for p in source.glob('*.jsonl.gz')},
                    corpus_samples=statistics, split_game_ids={k: sorted(v) for k, v in identities.items()})
    if args.archive:
        manifest['archive_audit'] = audit_archive(args.archive, corpus, identities)
    if args.transfer:
        manifest['transfer_sha256'] = digest(args.transfer)
    write_json(args.output / 'manifest.json', manifest)
    train = datasets['train']
    sample = train[0]
    model = PolicyValue(len(sample['sn']), sample['an'].shape[-1], args.players)
    if args.transfer:
        initialize_four_player(model, load_model(args.transfer)[0])
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    rng = random.Random(args.seed)
    history, best = [], math.inf
    initial = evaluate_predictions(model, datasets['validation'])
    emit({'stage': 'initial-validation', **initial})
    for epoch in range(args.epochs):
        model.train()
        order = list(range(len(train)))
        rng.shuffle(order)
        running = Counter()
        for start in range(0, len(order), args.batch_size):
            rows = [train[i] for i in order[start:start + args.batch_size]]
            logits, values = model(collate(rows))
            labels = torch.tensor([r['label'] for r in rows])
            targets = torch.tensor([r['target'] for r in rows])
            policy_loss = nn.functional.cross_entropy(logits, labels)
            value_loss = nn.functional.binary_cross_entropy_with_logits(values, targets)
            loss = policy_loss + args.value_weight * value_loss
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.)
            optimizer.step()
            running['policy_loss'] += policy_loss.item() * len(rows)
            running['value_loss'] += value_loss.item() * len(rows)
        validation = evaluate_predictions(model, datasets['validation'])
        # Predeclared joint policy + value criterion; test is never used for selection.
        objective = validation['policy_nll'] + args.value_weight * validation['value_bce']
        record = {'epoch': epoch + 1, 'train': {k: v / len(train) for k, v in running.items()},
                  'validation': validation, 'selection_objective': objective,
                  'elapsed_seconds': round(time.monotonic() - started, 2)}
        history.append(record)
        save_model(args.output / 'last-pretrained.pt', model, {'epoch': epoch + 1, 'kind': 'pretrained'})
        if objective < best:
            best = objective
            save_model(args.output / 'pretrained.pt', model, {'epoch': epoch + 1, 'kind': 'pretrained'})
        emit({'stage': 'pretrain', **record})
        write_json(args.output / 'pretraining.json', {'initial_validation': initial, 'epochs': history})
    selected, metadata = load_model(args.output / 'pretrained.pt')
    report = {'initial_validation': initial, 'epochs': history, 'selected': metadata,
              'test': evaluate_predictions(selected, datasets['test']),
              'checkpoint_sha256': digest(args.output / 'pretrained.pt'),
              'elapsed_seconds': round(time.monotonic() - started, 2)}
    write_json(args.output / 'pretraining.json', report)
    emit({'stage': 'pretrain-complete', **report})


class Baseline:
    def __init__(self, run):
        self.process = subprocess.Popen(
            [shutil.which('node') or 'node', str(HERE / 'baseline-bridge.mjs'), str(run / 'snapshot/baseline')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', bufsize=1)
        self.plans = {}

    def choose(self, state, heuristic=False):
        who = state['next_move_player']
        planned = self.plans.pop(who, None)
        if state['next_move_choice'] == 'Which action?' and planned in state['next_move_options']:
            return planned
        self.process.stdin.write(json.dumps({'state': state, 'heuristic': True} if heuristic else state, separators=(',', ':')) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('Frozen baseline adapter stopped: ' + self.process.stderr.read()[:1000])
        rows = json.loads(line)
        if not isinstance(rows, list) or not rows:
            raise RuntimeError(f'Baseline failed: {rows}')
        if rows[0].get('nextDeploy'):
            self.plans[who] = rows[0]['nextDeploy']
        return rows[0]['move']

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class GameLimit(RuntimeError):
    pass


def play_game(match_type, encoder, baseline, policies, learner_seats, seed, output,
              sample, sampling_seed, seconds=30, decision_limit=1800, failure_output=None):
    baseline.plans.clear()
    started = time.monotonic()
    trajectories = {name: [] for name in learner_seats}
    counts = Counter()
    generator = torch.Generator().manual_seed(sampling_seed)
    calls = 0

    def choose(prompt, options, _undo):
        nonlocal calls
        calls += 1
        if calls > decision_limit or time.monotonic() - started > seconds:
            raise GameLimit('Game exceeded its decision/time budget')
        if match.invalid_move:
            raise RuntimeError('Engine rejected previous move: ' + match.invalid_move)
        legal = {str(option): option for option in options}
        if not legal:
            raise RuntimeError('Engine offered no legal choice')
        for confirm in CONFIRMATIONS:
            if confirm in legal:
                counts['forced'] += 1
                return legal[confirm]
        if len(legal) == 1:
            counts['forced'] += 1
            return next(iter(legal.values()))
        state = match.get_state()
        who = state['next_move_player']
        model = policies.get(who)
        if model is None or model == 'heuristic' or prompt not in SUPPORTED:
            counts['baseline' if model is None else 'fallback'] += 1
            selected = baseline.choose(state, heuristic=model == 'heuristic')
        else:
            features, moves = encoder.encode(state)
            model.eval()
            with torch.no_grad():
                logits, value = model(collate([features]))
                if sample:
                    log_probs = logits[0].log_softmax(-1)
                    selected_index = torch.multinomial(log_probs.exp(), 1, generator=generator).item()
                else:
                    selected_index = logits[0].argmax().item()
            selected = moves[selected_index]
            if who in trajectories:
                logprob = log_probs[selected_index].item() if sample else logits[0].log_softmax(-1)[selected_index].item()
                features.update(label=selected_index, old_logprob=logprob, old_value=value.sigmoid().item())
                trajectories[who].append(features)
            counts['policy'] += 1
        if selected not in legal:
            raise RuntimeError(f'Unavailable move {selected!r} at {prompt}')
        return legal[selected]

    names = [f'Seat{index}' for index in range(encoder.player_count)]
    match = match_type(player_names=names, seed=seed, move_getter=choose, rules=RULES)
    row = {'seed': seed, 'error': None}
    try:
        match.play()
        if not match.game_over or match.phase.name != 'SCORING' or match.round_number != 8:
            raise RuntimeError('Game did not reach round-eight scoring')
        ordered = sorted(match.players, key=lambda p: (-p.score(), -p.resource_remainder() if match.resource_remainder_tiebreaker else 0))
        ranks = {p.name: rank for rank, p in enumerate(ordered, 1)}
        rewards = {name: value_target(rank, encoder.player_count) for name, rank in ranks.items()}
        row.update(rewards=rewards, scores={p.name: p.score() for p in match.players},
                   remainders={p.name: p.resource_remainder() for p in match.players})
        if encoder.player_count == 4:
            row['ranks'] = ranks
        for name, trajectory in trajectories.items():
            for features in trajectory:
                features['target'] = rewards[name]
    except Exception as error:
        row.update(error=f'{type(error).__name__}: {error}', failed_actor=match.next_move_player,
                   failed_prompt=match.next_move_choice)
        # Incomplete episodes never create fabricated win/loss training targets.
        trajectories = {}
    replay = output or (failure_output if row['error'] else None)
    if replay is not None:
        replay.write_text(match.get_replay(), encoding='utf-8')
    row.update(duration_seconds=round(time.monotonic() - started, 3), decisions=calls,
               round=match.round_number, choices=dict(counts), replay=replay.name if replay else None)
    return row, [features for trajectory in trajectories.values() for features in trajectory]


def ppo_update(model, anchor, rows, optimizer, rng, epochs=3, batch_size=128):
    if not rows:
        raise ValueError('No completed learner trajectories')
    advantages = torch.tensor([r['target'] - r['old_value'] for r in rows])
    # Monte Carlo outcome advantages, gamma=1; no turn-order assumptions or
    # bootstrapping across another player's decisions are needed.
    advantages = (advantages - advantages.mean()) / advantages.std(unbiased=False).clamp_min(1e-6)
    metrics, batches = Counter(), 0
    for _ in range(epochs):
        order = list(range(len(rows)))
        rng.shuffle(order)
        for start in range(0, len(rows), batch_size):
            indices = order[start:start + batch_size]
            part = [rows[i] for i in indices]
            batch = collate(part)
            logits, values = model(batch)
            policy = Categorical(logits=logits)
            selected = torch.tensor([r['label'] for r in part])
            old = torch.tensor([r['old_logprob'] for r in part])
            logprob = policy.log_prob(selected)
            ratio = (logprob - old).exp()
            advantage = advantages[indices]
            policy_loss = -torch.minimum(ratio * advantage, ratio.clamp(.8, 1.2) * advantage).mean()
            targets = torch.tensor([r['target'] for r in part])
            value_loss = nn.functional.binary_cross_entropy_with_logits(values, targets)
            entropy = policy.entropy().mean()
            with torch.no_grad():
                reference, _ = anchor(batch)
                reference_probs = reference.softmax(-1)
            anchor_kl = (reference_probs * (reference.log_softmax(-1) - logits.log_softmax(-1))).sum(-1).mean()
            loss = policy_loss + .5 * value_loss - .01 * entropy + .02 * anchor_kl
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), .5)
            optimizer.step()
            approximate_kl = ((ratio - 1) - (logprob - old)).mean().item()
            for key, value in (('policy_loss', policy_loss.item()), ('value_loss', value_loss.item()),
                               ('entropy', entropy.item()), ('anchor_kl', anchor_kl.item()),
                               ('approximate_old_kl', approximate_kl)):
                metrics[key] += value
            batches += 1
            if approximate_kl > .03:
                return {k: v / batches for k, v in metrics.items()} | {'early_stop': True, 'samples': len(rows)}
    return {k: v / batches for k, v in metrics.items()} | {'early_stop': False, 'samples': len(rows)}


def board_seed(namespace, seed, index):
    return hashlib.sha256(f'nations-rl-v1/{namespace}/{seed}/{index}'.encode()).hexdigest()


def summarize(rows):
    attempted = len(rows)
    completed = [r for r in rows if not r['error']]
    wins = sum(r['rewards'][r['candidate']] for r in completed)
    paired = defaultdict(list)
    for r in rows:
        paired[r['seed']].append(float(not r['error'] and r['rewards'][r['candidate']] == 1))
    rates = [sum(values) / 2 for values in paired.values() if len(values) == 2]
    interval = None
    if len(rates) > 1:
        rng = random.Random(196)
        samples = sorted(sum(rng.choices(rates, k=len(rates))) / len(rates) for _ in range(4000))
        interval = [samples[100], samples[3899]]
    return {'attempted': attempted, 'completed': len(completed), 'wins': wins,
            'win_rate_all_attempts': wins / attempted if attempted else None,
            'paired_board_bootstrap_95': interval,
            'mean_vp_margin': float(np.mean([r['scores'][r['candidate']] - r['scores'][r['opponent']] for r in completed])) if completed else None,
            'failures': dict(Counter(r['error'] for r in rows if r['error']))}


def paired_improvement(before, after):
    def rewards(rows):
        return {(r['seed'], r['candidate']): float(not r['error'] and r['rewards'][r['candidate']] == 1) for r in rows}
    left, right = rewards(before), rewards(after)
    if left.keys() != right.keys():
        raise ValueError('Comparisons must use the same boards and seats')
    boards = defaultdict(list)
    for key in left:
        boards[key[0]].append(right[key] - left[key])
    differences = [float(np.mean(values)) for values in boards.values()]
    rng = random.Random(197)
    samples = sorted(float(np.mean(rng.choices(differences, k=len(differences)))) for _ in range(4000))
    return {'win_rate_difference': float(np.mean(differences)),
            'paired_board_bootstrap_95': [samples[100], samples[3899]], 'boards': len(differences)}


def experiment(args):
    run = args.run.resolve()
    manifest = verify_snapshot(run)
    model, _ = load_model(run / 'pretrained.pt')
    if model.config.get('player_count') == 4:
        raise ValueError('Use batch.py start for four-player self-play')
    output = run / args.name
    output.mkdir(exist_ok=False)
    (output / 'replays').mkdir()
    sys.path.insert(0, str(run / 'snapshot/engine'))
    from nations import Match
    encoder = Encoder(json.loads((run / 'snapshot/baseline/card-index.json').read_text(encoding='utf-8')))
    anchor = deepcopy(model).eval()
    previous = deepcopy(model).eval()
    baseline = Baseline(run)
    rng = random.Random(args.seed)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    repository = Path(manifest['repository_root'])
    protected = {p.name: digest(p) for p in (repository / 'live-player').glob('*.json')}
    report = {'arguments': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
              'rules': RULES, 'training': [], 'evaluations': {},
              'pretrained_sha256': digest(run / 'pretrained.pt'),
              'protected_models_before': protected,
              'ppo': {'clip': .2, 'gamma': 1., 'value_weight': .5, 'entropy_weight': .01,
                      'anchor_kl_weight': .02, 'max_old_kl': .03, 'epochs': 3,
                      'advantage': 'terminal win outcome minus pre-update value, normalized'}}
    write_json(output / 'results.json', report)
    try:
        # Evaluation boards are never visited by training or checkpoint selection.
        # The final checkpoint is the last update within the predeclared budget.
        training_start = time.monotonic()
        human_seeds = {seed for values in manifest.get('archive_audit', {}).get('seed_hashes', {}).values() for seed in values}
        episode, update, pending = 0, 0, []
        while episode < args.games and time.monotonic() - training_start < args.seconds:
            seat_number = (episode + episode // 4) % 2
            seat = f'Seat{seat_number}'
            other = f'Seat{1 - seat_number}'
            kind = ('latest', 'baseline', 'pretrained', 'previous')[episode % 4]
            policies = {seat: model, other: {'latest': model, 'baseline': None,
                                           'pretrained': anchor, 'previous': previous}[kind]}
            learners = list(policies) if kind == 'latest' else [seat]
            generated_seed = board_seed('training', args.seed, episode)
            if hashlib.sha256(bytes.fromhex(generated_seed)).hexdigest() in human_seeds:
                raise ValueError('Generated training seed overlaps the human corpus')
            row, samples = play_game(Match, encoder, baseline, policies, learners,
                                     generated_seed,
                                     output / 'replays' / f'train-{episode:04}.replay', True,
                                     args.seed + episode, seconds=args.game_seconds)
            episode += 1
            row.update(episode=episode, opponent_kind=kind, learner_seats=learners)
            report['training'].append(row)
            pending.extend(samples)
            emit({'stage': 'self-play', 'episode': episode, 'opponent': kind, 'error': row['error'],
                  'seconds': row['duration_seconds'], 'samples': len(samples)})
            if episode % args.games_per_update == 0 or episode == args.games:
                if pending:
                    previous = deepcopy(model).eval()
                    statistics = ppo_update(model, anchor, pending, optimizer, rng)
                    update += 1
                    path = output / f'ppo-{update:03}.pt'
                    save_model(path, model, {'kind': 'ppo', 'update': update, 'games': episode})
                    report.setdefault('updates', []).append(statistics | {'update': update, 'games': episode})
                    pending = []
                    emit({'stage': 'ppo-update', 'update': update, **statistics})
            write_json(output / 'results.json', report)
        if pending:
            statistics = ppo_update(model, anchor, pending, optimizer, rng)
            update += 1
            report.setdefault('updates', []).append(statistics | {'update': update, 'games': episode})
        if not update:
            raise RuntimeError('Budget produced no PPO updates from complete games')
        save_model(output / 'selfplay.pt', model, {'kind': 'ppo', 'update': update, 'games': episode})
        report['training_seconds'] = round(time.monotonic() - training_start, 2)
        report['selfplay_sha256'] = digest(output / 'selfplay.pt')
        for label, candidate in (('pretrained', anchor), ('selfplay', model)):
            rows = []
            report['evaluations'][label] = {'games': rows}
            for board in range(args.boards):
                for seat in range(2):
                    actor, other = f'Seat{seat}', f'Seat{1-seat}'
                    generated_seed = board_seed('evaluation', args.seed, board)
                    if hashlib.sha256(bytes.fromhex(generated_seed)).hexdigest() in human_seeds:
                        raise ValueError('Evaluation seed overlaps the human corpus')
                    row, _ = play_game(Match, encoder, baseline, {actor: candidate}, [],
                                       generated_seed,
                                       output / 'replays' / f'eval-{label}-{board:03}-{seat}.replay',
                                       False, args.seed, seconds=args.game_seconds)
                    row.update(candidate=actor, opponent=other, board=board)
                    rows.append(row)
                    report['evaluations'][label]['summary'] = summarize(rows)
                    write_json(output / 'results.json', report)
                emit({'stage': 'evaluation', 'model': label, 'boards': board + 1,
                      **report['evaluations'][label]['summary']})
        report['paired_improvement'] = paired_improvement(report['evaluations']['pretrained']['games'],
                                                         report['evaluations']['selfplay']['games'])
        report['protected_models_after'] = {p.name: digest(p) for p in (repository / 'live-player').glob('*.json')}
        report['protected_models_unchanged'] = protected == report['protected_models_after']
        report['complete'] = True
        write_json(output / 'results.json', report)
        emit({'stage': 'experiment-complete', 'evaluations': {k: v['summary'] for k, v in report['evaluations'].items()},
              'protected_models_unchanged': report['protected_models_unchanged']})
    finally:
        baseline.close()


def predict(args):
    run = args.run.resolve()
    verify_snapshot(run, runtime_sources=('model.py', 'encoding.py', 'baseline-bridge.mjs'))
    state = json.loads(args.state.read_text(encoding='utf-8'))
    model, metadata = load_model(run / args.checkpoint)
    count = model.config.get('player_count', 2)
    value_key = 'predicted_win_probability' if count == 2 else 'expected_league_points'
    encoder = Encoder(json.loads((run / 'snapshot/baseline/card-index.json').read_text(encoding='utf-8')), count)
    model.eval()
    moves = legal_moves(state)
    fallback = state['next_move_choice'] not in SUPPORTED
    forced = next((move for move in CONFIRMATIONS if move in state['next_move_options']), None)
    if forced is None and len(moves) == 1:
        forced = moves[0]
    if forced is not None or fallback:
        selected = forced
        if selected is None:
            baseline = Baseline(run)
            try:
                selected = baseline.choose(state)
            finally:
                baseline.close()
        if selected not in state['next_move_options']:
            raise ValueError(f'Unavailable move: {selected!r}')
        emit({'selected': selected, 'baseline_fallback': forced is None, 'metadata': metadata,
              value_key: None, 'ranking': []})
        return
    features, moves = encoder.encode(state)
    with torch.inference_mode():
        logits, value = model(collate([features]))
    selected = moves[logits[0].argmax().item()]
    ranking = sorted(zip(moves, logits.softmax(-1)[0].tolist()), key=lambda item: -item[1])
    emit({'selected': selected, 'baseline_fallback': False, 'metadata': metadata,
          value_key: value.sigmoid().item() if count == 2 else 1 + 4 * value.sigmoid().item(),
          'ranking': [{'move': move, 'probability': probability} for move, probability in ranking]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--threads', type=int, default=2)
    subparsers = parser.add_subparsers(dest='command', required=True)
    pre = subparsers.add_parser('pretrain')
    pre.add_argument('--corpus', type=Path, default=ROOT / '.data/human-policy/dynasty-v2')
    pre.add_argument('--archive', type=Path, help='Original replay archive for an independent seed-split audit.')
    pre.add_argument('--engine', type=Path, default=ROOT.parent / 'nations-server/Nations/nations')
    pre.add_argument('--output', type=Path, required=True)
    pre.add_argument('--epochs', type=int, default=4)
    pre.add_argument('--max-train', type=int, default=80000)
    pre.add_argument('--max-eval', type=int, default=12000)
    pre.add_argument('--batch-size', type=int, default=128)
    pre.add_argument('--learning-rate', type=float, default=.001)
    pre.add_argument('--value-weight', type=float, default=.5)
    pre.add_argument('--seed', type=int, default=161126)
    pre.add_argument('--players', type=int, choices=(2, 4), default=2)
    pre.add_argument('--transfer', type=Path, help='Initialize a four-player model from the two-player checkpoint.')
    exp = subparsers.add_parser('selfplay')
    exp.add_argument('--run', type=Path, required=True)
    exp.add_argument('--name', default='pilot')
    exp.add_argument('--games', type=int, default=64)
    exp.add_argument('--seconds', type=float, default=300)
    exp.add_argument('--games-per-update', type=int, default=8)
    exp.add_argument('--game-seconds', type=float, default=30)
    exp.add_argument('--boards', type=int, default=16)
    exp.add_argument('--learning-rate', type=float, default=.0001)
    exp.add_argument('--seed', type=int, default=161127)
    prediction = subparsers.add_parser('predict')
    prediction.add_argument('--run', type=Path, required=True)
    prediction.add_argument('--checkpoint', default='pretrained.pt')
    prediction.add_argument('--state', type=Path, required=True)
    args = parser.parse_args()
    if args.threads < 1:
        parser.error('Threads must be positive')
    if args.command == 'pretrain' and min(args.epochs, args.max_train, args.max_eval, args.batch_size, args.learning_rate, args.value_weight) <= 0:
        parser.error('Pretraining budgets and rates must be positive')
    if args.command == 'pretrain' and args.transfer and args.players != 4:
        parser.error('Transfer requires --players 4')
    if args.command == 'selfplay':
        if min(args.games, args.seconds, args.games_per_update, args.game_seconds, args.boards, args.learning_rate) <= 0:
            parser.error('Self-play budgets and rates must be positive')
        if not args.name or Path(args.name).name != args.name or args.name in ('.', '..'):
            parser.error('Experiment name must be one directory name')
    seed_all(getattr(args, 'seed', 161126), args.threads)
    if args.command == 'pretrain':
        pretrain(args)
    elif args.command == 'selfplay':
        experiment(args)
    else:
        predict(args)


if __name__ == '__main__':
    main()
