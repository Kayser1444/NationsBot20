# Nations policy/value experiments

The training code runs offline. Existing model files and dependencies are read
only. New runs refuse to overwrite an existing run directory. A compatible
export can be installed separately through the player workflow.

Self-play and benchmark rollouts filter out hires that would finish a wonder
with nowhere to place it. This includes free architects from Papal Indulgence,
Great Exhibition and Korea, and the Qin Dynasty special action.

## Policy-guided search to handoff

The offline `--policy-rollouts` benchmark uses the frozen policy to finish
the direct-play line first. It queues other legal moves at each visited
decision. It picks the branch with the smallest cumulative policy logit
loss relative to the local top choices, then follows the policy all the way
to its next handoff. Menus handled by the fallback use rank as the loss.

A separate value head scores only completed lines at opponent handoff or
before round resolution, when the acting player has zero main actions
remaining. The head takes the frozen board embedding and a round-resolution
indicator. The search keeps the best scored line within the existing time
and node budgets, favors direct play on a tied score, and falls back to
direct play when the baseline cannot reach a scorable handoff.

Train this head with `train_handoff_value.py --handoff-data <completed turn-aware run>`.
Pass its `handoff-value.pt` to `compare_position_microsearch.py --policy-rollouts
--value-head <checkpoint>` with the same direct-play benchmark reference.

## Policy rollouts to round settlement

`audit_public_round.py` checks the public-snapshot reconstruction at ordinary
main-action prompts against archived engine replays. It compares the legal menus
along the recorded continuation and the final board after settlement.
`benchmark_round_value.py --public-snapshot` uses the same reconstruction for
the search arm and keeps the full replay on the benchmark engine side. Search
requires contiguous public history and a matching root menu. Unavailable
positions use direct play. Simulated moves after the current decision stay
inside the search.

`train_round_value.py` trains a separate win scorer on snapshots taken after
production, war, the event, famine and all end-of-round hooks. Even rounds
include book scoring and end-of-age hooks. Round eight has an exact result
from the engine. The learned scorer uses both players' settled resources and
boards, abilities, the new player order, and the round and game settings.

`compare_position_microsearch.py --round-rollouts` completes the direct
line with the frozen 100K policy playing both sides, including decisions
made during resolution. It completes a line for a different current move
before exploring deeper deviations. Only settled comparisons can change the
current move. The search reuses settled lines and pending branches when the
actual moves match their replay prefixes. If the best line includes a
simulated Victoria Falls draw, the bot follows the direct policy for that
decision.

Use `tune_round_value.py` to replay complete direct and search continuations
from archived decisions where they disagree. Both sides use the frozen policy
after settlement. The post-round scorer learns to rank the pair by game
result and VP margin. Keep every position from a board in the same data split.
`benchmark_round_value.py` compares scorers or direct play head-to-head with
the same frozen policy, search budget, mixed settings and swapped seats.

`train_search_policy.py` updates just the policy head. An override becomes a
training example when it beats the direct line in at least two of three
paired continuations. Two continuations occasionally try the policy's
runner-up after settlement. Match the trained checkpoint against its source
using `benchmark_round_value.py --left-policy` with direct play on both sides
first, then with the same round scorer and public-snapshot search on both sides.

For an offline growth-choice comparison, pass `--growth-search --public-snapshot`
and the same round scorer for both arms. The left arm tries each growth option
with one greedy continuation per option. It uses the visible progress board,
the age-average famine rounded to whole food, and the median total public
architect supply for the age. The forecast has no event-specific effects.
The benchmark game still draws its real event after growth. Incomplete
comparisons and lines that draw at Victoria Falls fall back to the policy.

## Four-player pilot

The four-player encoder retains the actor and next rival features and adds
numeric features for the other two rivals in cyclic turn order. It pools
visible card tokens from all three rivals. The transfer arm initializes the
shared embeddings, position and action layers, and policy head from the
selected two-player checkpoint. The value head learns expected placement
points in both arms. Targets map first through fourth from 5/3/2/1 to
1/.5/.25/0 for the sigmoid value head.

Run both pretraining arms against the same four-player replay splits. Supply
`--archive` to audit the original seed groups. The following example assumes a
local copy of the archive and the selected 10,000-game checkpoint.

```powershell
$rlPython = '.data/nations-rl/.venv/Scripts/python.exe'
$rlArchive = Join-Path $env:USERPROFILE 'Downloads/completed_matches_2730.tar.gz'
& $rlPython -B experiments/nations-rl/train.py --threads 4 pretrain --players 4 --archive $rlArchive --output .data/nations-rl/four-transfer-v1 --transfer .data/nations-rl/batch-10000-v1/checkpoints/games-010000.pt --epochs 4 --max-train 100000 --max-eval 15000 --batch-size 256 --learning-rate .0005
& $rlPython -B experiments/nations-rl/train.py --threads 4 pretrain --players 4 --archive $rlArchive --output .data/nations-rl/four-fresh-v1 --epochs 4 --max-train 100000 --max-eval 15000 --batch-size 256 --learning-rate .0005
foreach ($arm in @('transfer', 'fresh')) {
  $parent = ".data/nations-rl/four-$arm-v1"
  & $rlPython -B experiments/nations-rl/batch.py start --run $parent --initial "$parent/pretrained.pt" --output ".data/nations-rl/four-$arm-pilot-v1" --games 512 --games-per-update 32 --monitor-every 256 --monitor-boards 12 --final-boards 48 --workers 6
}
```

The batch derives player count from its checkpoint. Four-player training mixes
self-play, frozen Human Baseline v2, the full-hour heuristic, and policies from
earlier checkpoints. The report records league points, placements and failures.
It compares the selected candidate against the baseline taking the same seat on
the same boards, against both three baselines and a lineup with two baselines
and one full-hour heuristic. Each board is evaluated with all four candidate
seats. Confidence intervals resample whole boards. Failed evaluation games
receive one point and are shown separately from genuine fourth places.
The four-player export uses the version 2 format. Use `export.py` with the
training run's frozen card index and validate it with `check_export.py` before
using it in the player. Four-player exports appear as choices for four-player
seats and as account defaults. An account default falls back to the service
default for other player counts.

### Four-player results, 2026-11-16

Both pilots completed 512 training games. On 48 held-out boards per lineup,
the transferred policy averaged 2.984 league points against three Human
Baseline v2 bots and 3.729 in the mixed lineup. The fresh model averaged
2.214 and 2.979 on the same boards. The paired transfer gains were
+0.771 (95% interval +0.495 to +1.052) and +0.750 (+0.479 to +1.031).

The transfer winner continued for 2,048 more games with a new optimizer,
training seed and board sets. Both pilots and the continuation completed
without training failures. The final checkpoint led on the monitoring boards
and was selected before evaluation on 96 fresh boards per lineup.

| Opponents | Reference v2 | Selected policy | Paired gain (95% interval) |
| --- | ---: | ---: | ---: |
| Three v2 bots | 2.750 | 3.315 | +0.565 (+0.401 to +0.729) |
| Two v2 bots and one full-hour heuristic | 3.159 | 3.914 | +0.755 (+0.552 to +0.945) |

The selected policy finished first 148/384 times against three v2 bots and
210/384 times in the mixed lineup. Against three v2 bots, the pilot start
scored 2.927 on the continuation's final boards. The final checkpoint gained
+0.388 league points over it (95% interval +0.180 to +0.602).
Reports and replays are under `.data/nations-rl/four-scale-v1`.

To continue with a stopping rule, use `--patience 2 --monitor-every 1000`
in place of `--games`. This evaluates the starting model and each completed
batch on the same boards and four seat rotations against Human Baseline v2.
Average league points must strictly exceed the previous best to reset the
counter. The best checkpoint is evaluated once more on independent boards.
If interrupted, resume from the run's frozen `batch.py` entry point. Saved
evaluation reports let resumption recover the counter at the last checkpoint.

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

### Mixed game settings

Use `--mixed-settings` in `continue_position_selfplay.py` to warm-start the
mixed-settings encoder from a normalized-wonder-slot policy checkpoint. The
two-player schedule uses 30% Emperor, 30% King, 30% Prince, and 10% Chieftain.
Draft pools of two, three, and four nations are equally frequent. Each nerf
is enabled for half the boards, weighted draw for 70%, and the resource
remainder tiebreaker for every board. The other 30% use plain draws.

For a monitoring reference, put a copy of the starting checkpoint named
`structured.pt` and its `manifest.json` in a fresh evaluation directory. Run
`compare_position_encoding.py --evaluate-only --benchmark-only --mixed-settings`
with the same board count and seed as the training monitor. Mixed checkpoints
carry the setting schedule in their run manifest. Add `--mixed-settings` to
`compare_position_checkpoints.py` to compare older checkpoints on the same mix.
Direct benchmarks play both seats on each board under identical settings and
report results by difficulty.

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
