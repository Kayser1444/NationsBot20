"""Train and evaluate editable Nations weights with local simulated games."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
import copy
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import sys
import time

from nations_policy import ROOT, SharedScorer

_scorer = None
BASE = ROOT / "live-player/default-weights.json"


def initialize():
    global _scorer
    sys.path.insert(0, str(ROOT.parent / "nations-server/Nations"))
    _scorer = SharedScorer()


def simulate(task):
    from nations import Match
    label, count, seed, seat, model, opponents = task
    names = [f"Player{i}" for i in range(count)]
    actor = names[seat]
    assignments = {
        name: model if name == actor else opponents[(seed + index) % len(opponents)]
        for index, name in enumerate(names)
    }
    _scorer.configure(assignments)
    decisions = 0
    rules = dict(growth_resources=2, extra_draft_nations=1, resource_remainder_tiebreaker=True,
                 card_draw_limits=True, korea_nerf=True, lincoln_nerf=True)

    def choose(prompt, options, undo):
        nonlocal decisions
        decisions += 1
        if not options:
            raise RuntimeError("engine offered no legal choices: " + prompt)
        if decisions > 1800:
            raise RuntimeError("decision limit exceeded")
        if len(options) == 1:
            return options[0]
        selected = _scorer.choose(match.get_state())
        for option in options:
            if str(option) == selected:
                return option
        raise RuntimeError(f"scorer selected an unavailable move at {prompt}")

    match = Match(player_names=names, seed=f"{seed:x}", move_getter=choose, rules=rules)
    try:
        match.play()
        if not match.game_over or match.round_number != 8:
            raise RuntimeError("match ended before final scoring")
        ordered = sorted(match.players,
                         key=lambda player: (-player.score(), -player.resource_remainder(), match.players.index(player)))
        place = next(index for index, player in enumerate(ordered, 1) if player.name == actor)
        reward = float(place == 1) if count == 2 else ((5, 3, 2, 1)[place - 1] - 1) / 4
        scores = {p.name: p.score() for p in match.players}
        margin = scores[actor] - statistics.mean(score for name, score in scores.items() if name != actor)
        return dict(label=label, count=count, seed=seed, seat=seat, reward=reward,
                    place=place, margin=margin, decisions=decisions, error=None)
    except Exception as error:
        return dict(label=label, count=count, seed=seed, seat=seat, reward=0.0, place=None,
                    margin=None, decisions=decisions, error=f"{type(error).__name__}: {error}")


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def tasks_for(label, model, count, seeds, opponents):
    return [(label, count, seed, seat, model, opponents) for seed in seeds for seat in range(count)]


def summarize(rows):
    completed = [row for row in rows if row["place"] is not None]
    boards = defaultdict(list)
    for row in rows:
        boards[row["seed"]].append(row["reward"])
    averages = [statistics.mean(values) for values in boards.values()]
    error = statistics.stdev(averages) / math.sqrt(len(averages)) if len(averages) > 1 else 0
    return dict(
        attempted=len(rows), completed=len(completed), failed=len(rows) - len(completed),
        reward=statistics.mean(row["reward"] for row in rows) if rows else 0,
        wins=sum(row["place"] == 1 for row in rows),
        placements=dict(Counter(row["place"] for row in completed)),
        mean_vp_margin=statistics.mean(row["margin"] for row in completed) if completed else None,
        reward_standard_error_by_seed=error,
        failures=dict(Counter(row["error"] for row in rows if row["error"])),
    )


def evaluate(pool, models, count, seeds, opponents):
    tasks = [task for label, model in models.items() for task in tasks_for(label, model, count, seeds, opponents)]
    rows = list(pool.map(simulate, tasks, chunksize=1))
    return rows, {label: summarize([row for row in rows if row["label"] == label]) for label in models}


def mutate(parent, mode, rng, sigma):
    result = copy.deepcopy(parent)
    result["name"] = f"candidate-{mode}"
    profile = result.setdefault("profiles", {}).setdefault(str(mode), {})
    for key, base in parent["weights"].items():
        current = parent.get("profiles", {}).get(str(mode), {}).get(key, base)
        if key == "pass":
            profile[key] = max(-3, min(3, current + rng.gauss(0, sigma)))
        else:
            profile[key] = round(max(0.02, min(18, max(0.05, current) * math.exp(rng.gauss(0, sigma)))), 6)
    return result


def train(args, output):
    initial = json.loads(BASE.read_text(encoding="utf-8"))
    starting = json.loads(args.initial_model.read_text(encoding="utf-8")) if args.initial_model else initial
    champions = {mode: copy.deepcopy(starting) for mode in args.players}
    atomic_json(output / "starting-model.json", starting)
    history = {mode: [] for mode in args.players}
    rng = random.Random(args.seed)
    start = time.monotonic()
    deadline = start + args.seconds
    generations = Counter()
    total_games = 0
    with ProcessPoolExecutor(max_workers=args.workers, initializer=initialize) as pool:
        while time.monotonic() < deadline:
            for mode in args.players:
                if time.monotonic() >= deadline:
                    break
                generation = generations[mode]
                seeds = [args.seed + 10_000 * mode + 100 * generation + i for i in range(args.boards)]
                models = {"incumbent": champions[mode]}
                sigma = max(0.12, 0.45 * 0.97 ** generation)
                for index in range(args.population - 1):
                    models[f"mutation-{index}"] = mutate(champions[mode], mode, rng, sigma)
                opponents = [initial, starting, *history[mode][-3:]]
                if args.legacy_opponent:
                    opponents.insert(1, "v02")
                rows, summaries = evaluate(pool, models, mode, seeds, opponents)
                total_games += len(rows)
                best = max(summaries, key=lambda label: summaries[label]["reward"])
                # Preserve the current champion unless a mutation beats it on
                # this generation's matched boards against the same pool.
                if best != "incumbent":
                    history[mode].append(champions[mode])
                    champions[mode] = models[best]
                generations[mode] += 1
                champion = copy.deepcopy(champions[mode])
                champion["name"] = f"pilot-{mode}p-generation-{generation + 1}"
                atomic_json(output / f"candidate-{mode}p.json", champion)
                atomic_json(output / "checkpoints" / f"{mode}p-{generation + 1:04d}.json", champion)
                record = dict(mode=mode, generation=generation + 1, best=best, summaries=summaries,
                              elapsed_seconds=round(time.monotonic() - start, 2))
                with (output / "generations.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(record) + "\n")
                with (output / "training-games.jsonl").open("a", encoding="utf-8") as stream:
                    for row in rows:
                        stream.write(json.dumps(row) + "\n")
                print(json.dumps(dict(mode=mode, generation=generation + 1, games=total_games,
                                      elapsed=record["elapsed_seconds"], best=best,
                                      reward=summaries[best]["reward"])), flush=True)
        training_elapsed = time.monotonic() - start
        validation = {}
        for mode in args.players:
            seeds = [args.seed + 9_000_000 + 100 * mode + i for i in range(args.validation_boards)]
            comparison = {"candidate": champions[mode], "initial": initial, "v02": "v02"}
            if args.initial_model:
                comparison["starting"] = starting
            opponents = [initial, starting]
            if args.legacy_opponent:
                opponents.insert(1, "v02")
            rows, summaries = evaluate(pool, comparison, mode, seeds, opponents)
            validation[mode] = summaries
            with (output / "validation-games.jsonl").open("a", encoding="utf-8") as stream:
                for row in rows:
                    stream.write(json.dumps(row) + "\n")
            atomic_json(output / "validation.json", validation)
            print(json.dumps(dict(mode=mode, validation=summaries)), flush=True)
    source_files = ["live-player/scorer.mjs", "live-player/default-weights.json", "live-player/card-index.json",
                    "live-player/local-bridge.mjs", "scripts/train-nations.py"]
    report = dict(
        seconds_requested=args.seconds, training_seconds=training_elapsed,
        total_seconds=time.monotonic() - start, training_games=total_games,
        generations=dict(generations), workers=args.workers, seed=args.seed,
        population=args.population, boards_per_generation=args.boards,
        validation_boards=args.validation_boards, validation=validation,
        starting_model=str(args.initial_model) if args.initial_model else None,
        legacy_opponent=args.legacy_opponent,
        source_sha256={name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_files},
        engine_sha256=hashlib.sha256((ROOT.parent / "nations-server/Nations/nations/match.py").read_bytes()).hexdigest(),
    )
    atomic_json(output / "summary.json", report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--players", type=int, nargs="+", choices=(2, 4), default=[2, 4])
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--population", type=int, default=5)
    parser.add_argument("--boards", type=int, default=2)
    parser.add_argument("--validation-boards", type=int, default=16)
    parser.add_argument("--seed", type=int, default=151100)
    parser.add_argument("--initial-model", type=Path, help="start from a reviewed model instead of default weights")
    parser.add_argument("--legacy-opponent", action="store_true", help="include v0.2 in the opponent pool")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if min(args.seconds, args.workers, args.boards, args.validation_boards) < 1 or args.population < 2:
        parser.error("all budgets must be positive and population must be at least two")
    if args.output.exists():
        parser.error("choose a new output directory to preserve previous results")
    args.output.mkdir(parents=True)
    train(args, args.output)


if __name__ == "__main__":
    main()
