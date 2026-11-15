"""Compare training runs on fresh, seat-rotated two- and four-player boards."""

import argparse
from concurrent.futures import ProcessPoolExecutor
import importlib
import json
import math
from pathlib import Path
import statistics

training = importlib.import_module("train-nations")


def compare(rows, label, count):
    grouped = {}
    for row in rows:
        grouped.setdefault((row["label"], row["seed"]), []).append(row["reward"])
    seeds = sorted({row["seed"] for row in rows})
    differences = [statistics.mean(grouped[label, seed]) - statistics.mean(grouped["initial", seed])
                   for seed in seeds]
    scale = 1 if count == 2 else 4
    mean = scale * statistics.mean(differences)
    interval = 1.96 * scale * statistics.stdev(differences) / math.sqrt(len(seeds)) if len(seeds) > 1 else 0
    return dict(delta=mean, approximate_95_percent_interval=[mean - interval, mean + interval])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, nargs="+", required=True)
    parser.add_argument("--boards", type=int, default=32)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--seed", type=int, default=19151100)
    parser.add_argument("--opponent-model", type=Path, help="use a fixed model with initial weights in the opponent pool")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.boards < 2 or args.workers < 1:
        parser.error("choose a new output directory, at least two boards and positive workers")
    args.output.mkdir(parents=True)
    initial = json.loads(training.BASE.read_text(encoding="utf-8"))
    opponent = json.loads(args.opponent_model.read_text(encoding="utf-8")) if args.opponent_model else "v02"
    report = {}
    with ProcessPoolExecutor(max_workers=args.workers, initializer=training.initialize) as pool:
        for count in (2, 4):
            models = {"initial": initial, "v02": "v02"}
            for run in args.runs:
                models[run.name] = json.loads((run / f"candidate-{count}p.json").read_text(encoding="utf-8"))
            seeds = [args.seed + 100 * count + offset for offset in range(args.boards)]
            rows, summaries = training.evaluate(pool, models, count, seeds, [initial, opponent])
            for label, summary in summaries.items():
                summary["paired_vs_initial"] = compare(rows, label, count)
                if count == 4:
                    summary["league_points"] = 1 + 4 * summary["reward"]
            report[count] = summaries
            with (args.output / "games.jsonl").open("a", encoding="utf-8") as stream:
                for row in rows:
                    stream.write(json.dumps(row) + "\n")
            training.atomic_json(args.output / "summary.json", report)
            print(json.dumps({"players": count, "results": summaries}), flush=True)
    training.atomic_json(args.output / "configuration.json", {
        "runs": [str(run.resolve()) for run in args.runs], "boards": args.boards,
        "seed": args.seed, "workers": args.workers,
        "opponent_model": str(args.opponent_model.resolve()) if args.opponent_model else "v02",
    })


if __name__ == "__main__":
    main()
