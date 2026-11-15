"""Play a local two-player match using Tabony's Python engine."""

import argparse
from collections import Counter
import os
from pathlib import Path
import random
import sys

from nations_policy import bot_move


DEFAULT_ENGINE = Path(__file__).resolve().parents[2] / "nations-server" / "Nations"


def play(seed, opponent, reverse_seats):
    from nations.cli import NationsCLI

    names = ["NationsBot", {"baseline": "Baseline", "random": "Random", "human": "You"}[opponent]]
    if reverse_seats:
        names.reverse()
    generators = {name: random.Random(f"{seed}:{name}") for name in names}
    interface = NationsCLI(player_names=names, seed=f"{seed:x}", verbose=opponent == "human")
    match = interface.match
    human_prompt = interface.get_move_prompt

    def get_move(choice, options, undo):
        name = match.current_player.name
        if name == "You":
            return human_prompt(choice, options, undo)
        return bot_move(match, choice, options, generators[name], baseline=name != "Random")

    match.move_getter = get_move
    interface.play()
    return match


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, default=DEFAULT_ENGINE,
                        help="directory containing the nations Python package")
    parser.add_argument("--opponent", choices=("baseline", "random", "human"), default="baseline")
    parser.add_argument("--games", type=int, default=1)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--weights", type=Path, help="editable model JSON to use locally")
    parser.add_argument("--replay-out", type=Path, help="save a single match as a .replay file")
    args = parser.parse_args()
    if args.weights:
        if not args.weights.is_file():
            parser.error("--weights must name an existing JSON model")
        os.environ["NATIONS_PLAYER_WEIGHTS"] = str(args.weights.resolve())
    if args.games < 1 or args.seed < 0:
        parser.error("--games must be positive and --seed must be nonnegative")
    if args.games > 1 and (args.opponent == "human" or args.replay_out):
        parser.error("use a single game with a human opponent or --replay-out")
    if args.replay_out and args.replay_out.exists():
        parser.error(f"replay already exists: {args.replay_out}")
    if not (args.engine / "nations" / "match.py").is_file():
        parser.error("pass --engine with the path to the directory containing Tabony's nations package")
    sys.path.insert(0, str(args.engine.resolve()))

    wins = Counter()
    for index in range(args.games):
        seed = args.seed + index // 2
        try:
            match = play(seed, args.opponent, reverse_seats=index % 2 == 1)
        except EOFError:
            print("Input ended before the match finished.", file=sys.stderr)
            return 1
        if args.replay_out:
            args.replay_out.parent.mkdir(parents=True, exist_ok=True)
            with args.replay_out.open("x", encoding="utf-8") as stream:
                stream.write(match.get_replay())
            print(f"Saved replay to {args.replay_out}")
        if not match.game_over:
            print(f"Stopped in round {match.round_number}.")
            return 1
        if match.round_number != 8:
            print(f"Game ended in round {match.round_number}.")
            continue
        # The local engine uses final VP, then current turn order by default.
        scores = [(player.score(), player) for player in match.players]
        winner = max(scores, key=lambda result: result[0])[1]
        wins[winner.name] += 1
        if args.games == 1:
            print(f"Finished eight rounds in {match.move_number} decisions.")
            for points, player in scores:
                print(f"{player.name} ({player.nation.name}): {points} VP")
            print(f"Winner: {winner.name}")
    if args.games > 1:
        print(f"Finished {wins.total()}/{args.games} games through round 8.")
        for name, count in wins.most_common():
            print(f"{name}: {count} wins")
        return int(wins.total() != args.games)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
