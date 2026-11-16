# Two-player policy/value experiment

This is an offline experiment. Nothing imports it from the Discord bot, hosted
player, model selectors or browser game. Existing model files and dependencies
are read only. New runs refuse to overwrite an existing run directory.

## First pilot, 2026-11-16

Pretraining used 219,672 decisions from 1,118 two-player games. An interruption
stopped the run after three of six planned epochs. The saved checkpoint from
epoch two had the lowest combined validation loss of the completed epochs. On
the 134 held-out human games it predicted the recorded move 43.9% of the time
and had a win-probability Brier score of 0.166, compared with 0.250 for a
constant 50% estimate.

The pilot completed 256 training games and 16 PPO updates in 87.7 seconds.
Each checkpoint played both seats on the same 32 evaluation boards against the
frozen current baseline. All 128 evaluation games completed.

| Checkpoint | Wins | Win rate | Mean VP margin |
| --- | ---: | ---: | ---: |
| Pretrained | 20 / 64 | 31.3% | −6.41 |
| After self-play | 29 / 64 | 45.3% | −1.19 |

The estimated gain was 14.1 percentage points, with a paired board bootstrap
95% interval of −1.6 to +29.7 points. This run favors self-play, with enough
uncertainty to leave the size and direction of the improvement unresolved.
The run is in `.data/nations-rl/two-player-v1`, with the match report and the
self-play checkpoint under `pilot/`. Hash checks confirmed that the existing
player model files were identical before and after the experiment.

## Environment

Use a separate Python 3.12 environment inside the ignored `.data` directory.
For example, from the repository root in PowerShell:

```powershell
& '../nations-server/.venv/Scripts/python.exe' -m venv .data/nations-rl/.venv
uv --cache-dir .data/nations-rl/uv-cache pip install --python .data/nations-rl/.venv/Scripts/python.exe -r experiments/nations-rl/requirements.txt --index-url https://download.pytorch.org/whl/cpu
```

Node.js is needed only for the frozen baseline opponent and fallback decisions.
Training uses CPU PyTorch; no OpenAI API, live Tabony login, Discord connection,
service change or deployment is involved.

## Train and run a pilot

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/train.py --threads 2 pretrain --output .data/nations-rl/my-run --corpus .data/human-policy/dynasty-v2 --archive "$env:USERPROFILE/Downloads/completed_matches_2730.tar.gz" --max-train 250000 --max-eval 50000 --epochs 6 --batch-size 256
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/train.py --threads 2 selfplay --run .data/nations-rl/my-run --name pilot --games 256 --seconds 300 --games-per-update 16 --boards 32
```

`--archive` independently audits the corpus's seed-grouped splits against the
original archive and checks its hash. It is optional for another pre-existing
corpus, but without it only disjoint match IDs are independently verified.
`--max-train` and `--max-eval` cap decisions with deterministic uniform reservoir
sampling; the commands above include every eligible two-player decision in the
current corpus. Outcome and recorded move are labels, never features.

The game count and time cap apply to self-play collection, stopping at the next
game boundary. A game has its own time and decision limits. The last PPO update
and final evaluation require additional time. Both the pretrained and final
checkpoint play both seats of each fresh evaluation board against the same
baseline. Evaluation games never select a PPO checkpoint. The self-play model
is the last checkpoint within the declared training budget, even if it is worse.

Every run snapshots the engine, baseline source/assets/models and experimental
source, with SHA256 provenance. To reproduce a saved run after development has
changed the experiment, use its frozen entry point:

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B .data/nations-rl/my-run/snapshot/experiment/train.py --threads 2 selfplay --run .data/nations-rl/my-run --name repeat --games 256 --seconds 300 --games-per-update 16 --boards 32
```

Use a generous time cap and a fixed game count for exact episode-count
reproduction. Time-limited runs can stop at different episode counts on other
machines. CPU math, Python/Node versions and the pinned libraries also matter.

## Continue training in a resumable batch

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/batch.py start --run .data/nations-rl/two-player-v1 --initial .data/nations-rl/two-player-v1/pilot/selfplay.pt --output .data/nations-rl/batch-10000-v1 --games 10000 --workers 6
```

The batch uses the pilot's trained weights and starts a fresh Adam optimizer.
The pretrained model remains the PPO regularization target. Half the games pit
the current policy against itself, one quarter use the frozen baseline, and
one quarter sample from the pretrained policy, the starting model and up to
four older batch checkpoints. Training alternates seats for each opponent type.

The batch commits learner weights, optimizer, random state, opponent pool and
game counters after each PPO update. `training.jsonl` and `updates.jsonl` are
append-only while running. If interrupted mid-update, resume discards any
uncommitted journal suffix and restarts from the last committed state.

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B .data/nations-rl/batch-10000-v1/snapshot/experiment/batch.py resume --output .data/nations-rl/batch-10000-v1 --workers 6
```

`--max-updates-this-session` pauses after the specified number of committed
updates. One training process can hold the run lock at a time. Keep the run
directory intact to resume, including its snapshot, journals and checkpoints.

Every 2,000 games, the new checkpoint runs against the baseline and the best
earlier checkpoint on monitoring boards. Selection uses wins against the
baseline, with mean VP margin as the tiebreaker. After selection is fixed, the
starting, selected and final checkpoints face the baseline on 200 separate
boards, with both seats played. A separate duel compares the selected and
starting checkpoints directly. Results, evaluation replays and checkpoint
hashes are saved inside the batch directory. `results.json` is written when
training and evaluation are complete.

The first 10,000-game batch completed on 2026-11-16 with 250 PPO updates and
zero failed training games. Training and updates took 15 minutes 48 seconds,
excluding evaluation. The final checkpoint led the monitoring benchmark and
won 270 of 400 held-out games against the baseline, compared with 157 of 400
for the starting checkpoint on the same boards. The paired gain was 28.3
percentage points (95% interval 22.0 to 34.3 points). In their direct matchup,
the final checkpoint won 307 of 400. The run and its selected checkpoint are
saved in `.data/nations-rl/batch-10000-v1`.

## Model and learning objective

The actor ranks the complete non-administrative legal candidate list. A shared
64-unit position encoder feeds a candidate policy network and a separate value
head predicting the acting player's probability of winning. Public numeric
features describe resources, production, workers, scores and printed card
properties. Hashed categorical embeddings describe visible cards, slots,
nations, event, war, prompt and candidate actions. The feature schema is versioned.
Unknown fields are ignored; no seed, deck order, RNG, player identity, match ID,
recorded choice, final rank or future score enters the observation encoder.
The `score` observation is the engine's public projected score at that position.

Supervised pretraining minimizes human-action cross entropy plus half the
binary win-value cross entropy. The checkpoint minimizes that combined loss on
validation games. Human test games are evaluated once after selection. Metrics
include legal-move accuracy, random-choice accuracy, value log loss and Brier
score; a constant 50% value prediction has Brier score 0.25.

PPO uses complete-game win/loss returns, an undiscounted outcome advantage
relative to the value prediction, clipped policy updates, value learning,
entropy exploration and a small KL penalty toward the pretrained policy.
There are no resource, production or military proxy rewards. Opponents cycle
between the latest policy, frozen current baseline, pretrained policy and
previous update; seats rotate for each opponent type. Latest-versus-latest
games contribute both players' trajectories. Failed games remain in the game
record, but contribute no invented terminal targets. Evaluation failures count
as non-wins. Final scoring follows the current benchmark's score/remainder
ordering, including stable ordering if both are equal.

The replay corpus covers draft, growth, action, benefit and dynasty prompts.
Other subdecisions use the frozen current baseline's tactical checks. Forced
confirmations are handled directly. The ten two-player dynasty examples are
especially sparse, so broad competence on those choices is not established.
The value head is used during training; this milestone has no tree search.

## Inspect a checkpoint

For a JSON position containing `players`, `next_move_player`,
`next_move_choice`, `next_move_options` and the visible board:

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/train.py predict --run .data/nations-rl/my-run --checkpoint pilot/selfplay.pt --state .data/my-position.json
```

The output reports the chosen move and whether it came from the baseline. At
learned prompts with multiple legal choices, it also reports move probabilities
and the model's estimated win probability.

Outputs are `pretrained.pt`, `last-pretrained.pt`, `pretraining.json`,
`manifest.json`, and the pilot's `selfplay.pt`, update checkpoints,
`results.json` and complete `.replay` records. Model files are standalone
experiment checkpoints, not compatible with the current hosted model selector.
The saved snapshot and encoder are required to interpret them.

## Verification

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B -m unittest discover -s experiments/nations-rl -p test_experiment.py -v
```

Tests exercise observation leakage/seat invariance, legal candidate masking,
padding invariance, supervised policy/value learning, checkpoint round trips,
actual PPO parameter updates, deterministic corpus sampling and failure
accounting. Full-engine smoke runs and final held-out games exercise the real
rules engine and frozen JavaScript baseline. Results must be interpreted against
that specific baseline, not as a measure of human playing strength.
