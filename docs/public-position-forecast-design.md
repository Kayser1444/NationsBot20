# Public-position forecast for the experimental player

Status as of 2026-11-18. The local replay runner implements a first step 1A
pilot. The public-position feature encoder and live integration remain design
work. Keep this document current as card batches are reviewed.

## Decision-system roadmap

1. **Next-move evaluator, including step 1A handoff search.** Score every
   currently legal move from the public position without searching opponent
   turns. Apply the move's immediate effects and search available decisions
   until control would pass to an opponent or the action phase ends. This may
   include another turn for the same player after everyone else has passed.
   Forecast the visible end-of-round mechanics from the
   resulting position. Add a separate estimate of retained future potential
   for abilities such as Marco Polo and a separate liability for effects such
   as Vesuvius. Make these estimates depend on relevant context, including
   rounds remaining and available resources, rather than card ID alone.
   Difficult residual value may use an explicit capability flag learned during
   training, for example Sun Tzu or Alhazen. Keep immediate effects, future
   potential, and learned flags distinct to avoid counting the same benefit
   twice. Unknown hidden draws and unavailable public counters remain unknown.
2. **Turn search.** Once the evaluator is useful on its own, use it to order
   candidate moves and to value search leaves. Simulate actual later turns,
   including opponent responses selected by the same policy, while preserving
   each player's information boundary. Retain some candidate diversity so a
   mistaken first-pass ranking does not permanently prune a strong move.
   Compare search against the evaluator alone on held-out games and human
   matches before relying on it.
3. **Optional reasoning layer.** Test an LLM as a controller or final
   tie-breaker only after the first two stages have a measured baseline. It
   may select among legal, evaluated actions or request searches, but its
   added latency, cost, and choice quality must be measured against the same
   positions. It does not replace the mechanical transition or public-rule
   boundary.

The shared boundary is the position after a candidate move's complete
immediate resolution and any searched same-player continuation, before an
opponent receives a turn. This includes Marco Polo, Suleiman I, and Lincoln
choices and can include several consecutive turns after all opponents pass.
Stage 2 is the first stage that searches opponent turns. Keep the evaluator
independently usable even after search and a reasoning layer are added.

### Step 1A handoff search: scope and safeguards

The engine's `take_turn` gives a player one main action, with extra actions
from effects such as Sun Tzu or Wardenclyffe. Undeploying does not consume a
main action. The action-phase loop then advances to the next unpassed player;
if every other player has passed, the same player receives a new turn. A
general search can enumerate the acting player's choices through that handoff
or through the end of the action phase. Evaluate each complete branch at a
comparable boundary, then apply the existing end-of-round forecast.

This is deterministic **conditional on all chosen actions and visible card
outcomes**. Some effects ask another player to choose during the current
action, such as Assassin or Titanic. Such nodes need an opponent-choice model
or an explicit set of conditional outcomes; the actor cannot select the most
favorable opponent response. Discovering Victoria Falls draws hidden cards
within the action. Treat this one automatic draw as a special uncertainty
frontier: apply known discovery effects, assign an estimated value or unknown
flag to the extra colony row, and stop exact continuation that depends on its
contents. When the last player passes, stop before next-round hidden draws.

The search is not naturally small when the same player can act repeatedly.
Use a shared tree across root moves, an expanded-node budget, a wall-clock
budget, a depth limit, and on-path cycle detection. A 1,000-node cap is a
safety limit to measure, not a guaranteed exhaustive search. Compare only
branches that reach the same kind of handoff; if the budget is hit before a
fair comparison, fall back to the one-move evaluator. Deduplicate by a
*future-behavior-equivalent* state signature that retains action allowance,
relevant turn-count predicates, per-round markers, trigger history, and
resources. Use the resource pruning heuristic below to reduce the cost of
step 1A and leave more budget for later turn search.

The [replay benchmark](#step-1a-replay-benchmark) measures how often the full
tree fits within the proposed node budget.

Start step 1A with **guided depth-first search and a fixed width of two**.
At ordinary action prompts, score the legal candidates after move grouping
and state pruning. Put the two highest ranked distinct moves on the DFS
stack and visit the higher ranked move first. Pass competes for one of
those slots under the same rule. Resolve forced steps inline and enumerate
small, finite follow-up choices, such as the eligible Turmoil benefits or
card placement slots, within the same node and time budgets. Rank a worker
transfer using the outcome after both steps.

Use the budget to get one line to handoff or action-phase end for each
shortlisted root before deepening either root. Depth measures main actions,
with node and time limits covering all prompts and transitions. Cache
equivalent positions and back up values from comparable handoff states.
Keep the one-move ranking when the search cannot produce a fair comparison.

Keep width fixed during the first training and evaluation runs. Use the
scorer's order directly at each ordinary prompt. Once the search works,
benchmark it with the existing weights and then retrain the scorer with
the same search configuration used at inference. Evaluate both sets of
weights against the same opponents, budgets, and held-out positions so
the effect of search and the effect of retraining can be measured.

The local engine can validate this design and its replay-based lookahead code
already branches on legal prompts. The hosted bot receives a public snapshot,
not an engine object or complete replay. Its snapshot omits `turn_number` and
`remaining_main_actions`, which affect Sun Tzu and extra-action effects. A live
step 1A therefore needs a maintained public-state transition and legal-option
generator, plus known/unknown tracking for missing counters. Current server
legal options are authoritative at the root; derived later options must be
verified against replay positions. Unsupported or ambiguous branches should
use the simpler valuation, not an invented exact successor.

Implementation order: use the local replay engine to test the handoff boundary,
branch budget, and ranking benefit on completed positions; then port the
supported deterministic transitions to a public-state simulator and compare
each derived successor and legal option list with engine replay fixtures. Keep
the same one-move evaluator as fallback and as the value function for partial
frontiers.

### Step 1A replay benchmark

The sample used 96 `Which action?` positions from 16 complete Tabony replays
in `completed_matches_2730.tar.gz`. It used four games per player count from
two through five, one position with active rivals per age per game, and two
positions per game where the actor was the last player to pass. Positions
were chosen with a fixed seed. Known NationsBot accounts and replays with
undos were excluded. This deliberately balanced sample gives each age and
player count coverage and oversamples positions with just one active player.

The benchmark counts decision paths, including the root and terminal leaves.
It follows forced choices inline, omits resignation and undo, and stops at
an opponent turn, a choice by an opponent, the end of the action phase, or a
hidden draw. It counts different paths that reach equivalent positions
separately. The depth-first traversal uses the Python engine at `55d5eef` and
replays the observed prefix to resume pending paths. Timings are local wall
time including replay overhead and exclude model evaluation.

| Position | Sampled | Finished in 1,000 nodes and 12 seconds | Mean full size is at least | Mean elapsed in capped run |
| --- | ---: | ---: | ---: | ---: |
| At least one rival active | 64 | 8 | 696.7 nodes | 9.42 s |
| All rivals passed | 32 | 0 | 877.9 nodes | 9.89 s |
| Total | 96 | 8 | 757.1 nodes | 9.57 s |

The lower bounds use visited nodes plus queued alternatives, whose descendants
are still unknown. Across all 96 positions, 37 hit the node limit and 51 hit
the time limit. The eight completed trees were all in age one. They averaged
118 nodes and 0.44 seconds, with 395 nodes and 1.95 seconds for the largest.
These completed-tree averages describe the easy subset.

Selected reruns with higher caps show the range beyond the main run:

| Match and decision | Context | Tree size | Elapsed |
| --- | --- | ---: | ---: |
| 909, decision 110 | Round 3, rival active | 2,325, complete | 11.58 s |
| 846, decision 157 | Round 4, rival active | At least 10,032 | 73.80 s at 10,000 nodes |
| 2119, decision 64 | Round 1, all rivals passed | At least 10,077 | 40.29 s at 10,000 nodes |
| 2443, decision 579 | Round 5, five players, five root choices | At least 2,013 | 47.43 s at 2,000 nodes |

Using the stronger bounds from these reruns, the sample mean is at least 974
nodes, with at least 882 when rivals are active and at least 1,159 when all
rivals have passed. The actual full-tree mean and maximum remain unknown.
Measure the effect of state deduplication and move ordering before setting a
live budget. Give guided depth-first search a time limit as well as a node
limit so replay or transition cost cannot dominate the decision time.

The runner is `scripts/benchmark-nations-handoff.py`. Use `--per-count 4
--seed 142 --nodes 1000 --seconds 12` to reproduce the main run. `--shards`
and `--shard` allow independent runs, and `--positions match00000909:110`
selects a root for a higher-budget rerun. The runner writes a JSON Lines
record for each sampled position. The combined results are in
`.data/handoff-benchmark-results.json`.

### Deduplication and resource dominance

First merge equivalent continuations. Use the game state, decision context,
and any remaining action allowance or rule counters that can change future
play as the cache key. Keep every root action that reaches that state, so all
receive credit for the continuation. Consecutive free undeploys are a useful
special case. When there are no active rank hooks, removing workers from A
then B has the same effect as B then A at the same prompt. With rank hooks,
intermediate thresholds can remove a card such as Great Library or Harald.
That can make the two orders materially different.

The benchmark's `--merge-undeploys` switch canonicalizes these consecutive
orders, with a guard for registered rank hooks. In a 12-position follow-up
chosen from the completed trees and higher-cap examples, it reduced one
completed tree from 395 to 213 nodes and another from 2,325 to 1,062.
The latter took 4.80 seconds with the merge and 11.58 seconds in the earlier
full run. For three completed positions, the distinct endpoint snapshots
and turn counters matched exactly before and after the merge. Both original
10,000-node examples still hit the follow-up's 3,000-node cap. This tests
one narrow equivalence rule.

For step 1A, treat one continuation as preferable when it keeps the same
board and action opportunity, changes no material effect, and leaves the
actor with at least as much of every resource and strictly more of one.
Compare the same phase, decision context, opponents, control of the turn,
and remaining actions. Apply the check after resolving the full sequence,
including any card triggers. That preserves genuine worker transfers,
purchases, and other actions that give something in exchange for resources.

This is an explicit search approximation. It can miss a line whose payoff
depends solely on deliberately going into a later choice or public round
resolution with lower Food, Military, Stability, or another resource. Mansa
Musa's last Gold reward is another example of why the comparison is a
heuristic. Actual purchases and the retained lines still resolve card,
event, war, and famine effects normally. War and events resolve after the
action phase in the current round, before the next round's hidden draws.

Preserve the option to delay passing when a rival can still act. A paid
redeploy can buy another turn after the rival commits. Once all rivals have
passed, prune a cycle that returns the worker to the same slot and only
spends Stone, provided the extra turn leaves relevant counters, effects, and
passed-over rewards equivalent. Use the replay benchmark to compare the
node savings and changes to the top-ranked move with pruning enabled.

The follow-up benchmark applies `--merge-undeploys` with `--state-pruning
equal` or `--state-pruning resources`. It checks ordinary action and turn
confirmation prompts before opening continuations. It compares mutable
player and card state, registered effects, the remaining action allowance,
and whether the current action or turn is the first. It merges an equal
position or skips one with strictly fewer resources when an earlier matching
position offered at least the same moves. The engine still stops at opponent
control or hidden information, so a line that delays passing cannot merge
with a line that already passed. Node counts include arrivals that trigger
pruning. This measures tree size under the benchmark's DFS order. The runner
does not rank moves or measure the effect on playing strength.

On the same 96 positions and initial limits of 1,000 nodes and 12 seconds,
the combined rules finished 16 trees, up from eight in the raw run. They
finished 14 of 64 positions with active rivals and two of 32 solo positions.
The 16 finished trees ranged from 20 to 929 nodes and averaged 366 nodes.
Including the higher-cap runs, the observed lower bound on the full sample
mean was 659.5 nodes. Two trees still had pending branches after 3,000 nodes.
The largest demonstrated lower bounds were 3,036 nodes with an active rival
and 3,074 with all rivals passed.

The two solo positions that finished at the initial limits also finished
with equality alone. Strict resource pruning reduced them from 280 to 269
and from 597 to 585 nodes. Across the 96 runs the combined rules stopped
9,655 continuations at equal states and 417 at strictly worse resource
positions. These are counts of pruning decisions. The size of the subtrees
they skipped varies.

| Action counted at an expanded edge | Active rival, 3,000 nodes | All rivals passed, 3,000 nodes |
| --- | ---: | ---: |
| Undeploy | 1,331 | 1,347 |
| Confirm with alternatives | 1,074 | 453 |
| Pass | 12 | 517 |
| Market purchase and placement | 252 | 190 |
| Deploy | 50 | 5 |
| Other follow-up choices, hires, Turmoil and benefits | 280 | 487 |

Each column excludes the root, so the action counts total 2,999 per column.
These are allocations of two capped DFS runs and depend on move ordering.
Undeploy does not use a main action. The player can therefore choose
different sets of workers to remove before acting, and the turn completion
prompt can allow another set of removals. Deduplication merges equivalent
orders but keeps different staffing levels. Once everybody else has passed,
each of these positions can feed more turns and a new choice about when to
pass. The measurements are in `.data/handoff-pruning-results.json`.

### Worker transfers

Treat an ordinary voluntary undeploy as the first step of a worker transfer.
Resolve the undeploy and then choose a legal deployment to a different card
on the same turn. The engine still applies the normal deployment cost and
any effects of either step. The benchmark follows both engine prompts and
counts both towards the node budget. When neither rank effects nor deployment
discounts can change the result, check for a viable destination before
opening the source branch.

Retain voluntary standalone undeploys when the deployed worker has any
active negative per-worker effect or when Varanasi rewards the idle worker.
Shantytown removes one Stability per worker, so undeploy can raise Stability
immediately and change event or war outcomes. Military upkeep can likewise
make an undeploy worthwhile on its own, including when it avoids a famine
deficit. If an active effect already waives military upkeep, that upkeep
does not qualify the worker for the exception. Apply these exceptions at
ordinary action and turn completion prompts. Choices required by card or
event resolution follow their own rules.

The restricted search can miss uses of idle workers or same-card redeploys
as a way of delaying a pass. The benchmark measures transfers between
different cards. A live policy that offers a deliberate wait can preserve
the same-card line when a rival still has an action. Repeated transfers
remain eligible for the resource comparison once they reach equivalent
positions.

With `--worker-transfers` and both earlier pruning rules enabled, 63 of the
same 96 replay positions finished under the 1,000-node and 12-second limits.
The earlier pruning rules alone finished 16. With transfers, 57 of 64
positions with active rivals and six of 32 solo positions finished. The 63
completed searches averaged 147 nodes and ranged from 10 to 731. A round
three position dropped from 706 to 28 nodes. A round four position that
previously exceeded 3,000 finished at 1,957, while the hard solo position
still had pending branches at 3,000. These timings and sizes cover traversal
of the restricted move set. They do not measure playing strength. The raw
measurements are in `.data/handoff-worker-transfer-results.json`.

### Ten-game microsearch pilot

Played five fresh two-player boards twice with the seats reversed, using the
frozen rules engine and selected 10,000-game checkpoint for both sides. One
side used the checkpoint directly. The other added replay-backed microsearch
with width two at ordinary action prompts, full menus of up to six follow-up
choices, a depth of three main actions, and limits of 40 replay transitions
and about 280 ms per decision. The runner stops at opponent control or before
round resolution. It values those snapshots using the existing checkpoint
with a fixed action prompt and one placeholder option. It uses the existing
prompt scores to build the shortlist and values a selected transfer after both
steps. The new public-position forecast and search-aware weights are outside
this pilot.

All ten games reached final scoring. Microsearch won five, with a mean margin
of +2.3 VP. It swept two board pairs, split one, and lost both games on two.
It attempted 669 searches, found comparable completed lines in 377, and
changed the first move in 203. Another 291 searches hit a node or time limit.
Mean game time was 12.31 seconds, 11.97 of which were measured inside search.
Search latency was 198 ms at the median and 297 ms at the 95th percentile.
The staggered parallel run took approximately 48 seconds. Five pairs give
an initial performance and cost reading for two players.

The runner is `scripts/evaluate-nations-lookahead.py --mode micro`. The seed,
checkpoint hashes, rules, scores, timing, and full replays are in
`.data/nations-predictive/micro-10-v1/`.

### Forty-game microsearch follow-up

The same checkpoint, rules, and search limits were tested on 20 fresh boards
with both seats played on each. Microsearch won 15 of 40 with a mean margin
of -2.2 VP. It swept four board pairs, split seven, and lost both games on
nine. The 95% bootstrap intervals over whole board pairs were 20% to 55% for
win rate and -5.55 to +1.15 VP for the mean margin. Across both runs it won
20 of 50 games with a mean margin of -1.3 VP. The follow-up did not reproduce
the positive VP margin from the pilot.

All 40 games reached final scoring. Mean game time was 13.59 seconds and
the parallel batch took about 125 seconds. Search changed the first move in
736 of 2,822 attempts and hit a node or time limit in 1,323. The seed, combined
report, per-board results, and full replays are under
`.data/nations-predictive/micro-40-v1/`.

### Handoff evaluator audit

Microsearch uses the checkpoint's separate win-probability head to rank
leaves. The direct checkpoint selects moves with its action head. In the
pilot, the simulator stopped before known round resolution and passed a
synthetic action prompt with only Pass to the value head. On 120 ordinary
prompts from the follow-up replays, changing only the legal menu shifted
predicted win probability by 2.7 percentage points on average and at most
9.7. Accuracy against the recorded winners under Brier score was nearly
unchanged in this probe.

The audit re-searched 33 final-round positions with all opponents passed.
It could compare completed lines from both root candidates in 12 cases.
Resolving the current war, events, and final scoring with the direct policy
for any public choices gave a worse VP margin for the preferred branch in
three cases. Both branches had the same winner in all 12. At decision 356
of the Seat1 game on seed `8c0d216f0766…`, the direct policy preferred Pass.
The leaf evaluator gave undeploying a Chariot worker and passing a 14.9%
win estimate versus 14.1% for Pass. Undeploying dropped the player below
the revealed Balkan Wars threshold, and the resolved margin worsened from
-11 to -15 VP.

A separate replay check found repeats of the same solo position with only
less Stone at 129 of 545 microsearch prompts and 79 of 482 direct-policy
prompts. These counts describe both policies' recorded play, including
fallback decisions. The lookahead cache is scoped to a root candidate and
search call, so the within-search prune cannot prevent cycles across real
decisions. Neither these counts nor the late-game examples establish the
cause of the overall win-rate gap. Details are in `handoff-audit.json` and
`cycle-audit.json` in the follow-up run directory.

### Resolved-round leaf scoring comparison

Recreated 73 decisions from the 40-game replays. The comparison froze the
width-two tree, the 40-node cap, and the checkpoint weights, and used a
longer audit deadline to reduce timing-related variation. Both scoring
methods saw the same completed lines. The alternate scorer applied the
revealed round through the engine before evaluating a leaf. The direct
policy handled public resolution choices on both sides. At an opponent
handoff, this is a forecast with the opponent's position frozen. At the
end of round eight, it uses the winner and then VP margin from final scoring.

| Sample | Positions compared | Changed line | Changed first move |
| --- | ---: | ---: | ---: |
| Round four, opponent still active | 31 of 40 | 7 | 4 |
| Round eight, all opponents passed | 12 of 33 | 3 | 3 |

Earlier positions still use the checkpoint's value estimate after applying
the public effects. In round eight, the new selection recovers 1, 2, and 4 VP
across the three changed positions, with the same winner in all 12. The
Balkan Wars example now selects Pass and keeps the -11 VP margin. All 24
final outcomes from the independent audit matched on the same paths. The
experiment measures changes in evaluation on replay positions. Playing
strength requires a separate matched-game comparison.

The runner is `scripts/compare-nations-micro-leaves.py`. Per-position trees,
scores and the summary are in `round-ablation-results.json` under the
40-game run directory.

The earlier-round checkpoint comparison can count the same effect twice
implicitly. Its encoder reads the current war, event, famine, and production
but ignores the engine's phase. The ablation passed in resources and points
after resolution with the same revealed event and action prompt. A replay
probe confirmed that changing only the phase had no effect on the value
prediction. The checkpoint was trained on actual decision prompts, so its
estimates for these synthetic resolved positions are diagnostic. Round-eight
final scores come directly from the engine and bypass the value model.

Use the actual phase to decide which board to value. At an active opponent
handoff, the current round is open. Score the position after the chosen
action, with war, events, and famine still pending and the actor's ability
to take another turn intact. The frozen-board resolution can supply a
conditional feature, such as the war loss if Military stays where it is.
Keep that feature separate from actual resources and points. Include the
Military gap to the war threshold and whether an idle Worker could deploy
to an owned Military card and close that gap at the current Stone cost.
This exposes the opportunity created by buying a Military card without
assuming the deployment will happen after the opponent acts.

When the action phase really ends, apply the revealed effects once, retain
their results in resources and points, and clear them from pending inputs.
Retain production rates as future capacity. Use final scoring if the game
ends. Train the value evaluator on both open and resolved positions with
the same phase-aware representation at inference. For open snapshots,
train against the outcome of the actual continued game and label any
frozen-board projection as conditional. Resolved snapshots teach the model
what follows after effects have been applied.

### Current-position encoder audit

The experimental checkpoint receives one state vector and one vector per
legal move. The state vector contains round, shared supplies, the revealed
war threshold, famine, player resources and production, Worker counts,
points, current board score, and pass flags. The card IDs, slots and deployed
Worker counts are pooled as hashed tokens. The move vector describes the
action and some printed stats of its target. The value head reads the state
vector, including legal move count. In four-player positions the numeric
fields distinguish opponents by seat, while their card tokens share the same
`rival` label. [Training encoder](../experiments/nations-rl/encoding.py)
and [live encoder](../live-player/rl-policy.mjs).

Two checks against the frozen 10,000-game checkpoint illustrate different
failure modes. Both positions came from the Seat1 replay on seed
`8c0d216f076679ed` in `micro-40-v1/shard-3/replays/`.

| Position | What the checkpoint sees |
| --- | --- |
| Great Wall, round 5, decision 168 | With the legal menu fixed, changing just the completed stages from one of two to zero left all nine move scores and the 45.30% win estimate identical. Adding one Stone in a separate copy moved the estimate to 45.80%. Each stage costs one Stone, and only the real position completes Great Wall on the next successful hire. Construction progress is present in the snapshot and missing from both encoders. |
| Balkan Wars, round 8, decision 356 | Passing keeps Military at 7 against a threshold of 7. Undeploying the Chariot and then passing leaves Military at 4, Stability at 0, and only 6 Books to absorb a 7-Book penalty. The raw strength difference is visible. The checkpoint rates the weaker branch higher at 14.89% versus 14.07%. The actual final margin is four VP worse. |

The human training extractor preserves `cards` with construction and
exploration progress. It omits engine `phase`, Worker pools, extra Worker
counts, pass order flags and deficit history. The outer `phase` field names
the prompt family. The first 2,500 rows of the `dynasty-v2` training split
included 1,126 with recorded construction progress and 74 with exploration
progress. Exact phase and the omitted player fields require fresh extraction
from the source replays if used for training. Match-specific effects also
depend on which fields the hosted snapshot actually exposes.
[Human replay extractor](../scripts/extract-human-nations.py).

### Other inputs to structure

The encoder looks up IDs and strings in a learned embedding table. The
hash key has no numeric game meaning. Combinations such as card plus
market slot or card plus deployed Worker count get separate tokens. The
state encoder pools them, so the model must recover ownership and learn
the same game relationship across combinations from examples.

| Current input | Proposed representation |
| --- | --- |
| War ID | Use pending status, threshold, penalty by resource, relevant modifiers and exemptions, and each player's effective Military margin and conditional losses. Test dropping the ID when those cover the war rules. |
| Exact move and prompt strings | Use a decision category and typed action fields, including target, price, resource quantity and immediate changes. Keep the prompt category where the same action has different meaning across phases. |
| Owned and market card IDs, dynasty and nation names | Put playable abilities, costs, production, Worker capacity and progress on the appropriate card or slot. Include nation-specific board rules and draft capabilities. Retain identity where relevant effects are still missing from the structured features. |
| Compound card, slot and deployment tokens | Bind the card's features to its seat and slot, with deployed Workers and market price as counts. In four-player games, distinguish whose abilities, cards and resources they are. |

Audit numeric inputs for information lost before training. The current
Books stock input clips every value above 60 to the same number. That
occurred in 48 of the 2,482 observations with player resources present
in the first 2,500 training rows checked. Keep Books margins and rank
explicit. Choose numeric scales that preserve meaningful differences,
and distinguish zero from unavailable data.

### Proposed current-position features

Use the same per-player fields for every seat, indexed relative to the player
whose position is being valued. Encode three kinds of information explicitly.

| Input group | First fields to expose |
| --- | --- |
| Board facts | Phase, actual order, active seats, whether the valued player can still act this round, stocks and net production per resource, and construction/exploration progress. For a Wonder, include stages left and the next Architect's effective cost when known. Keep public card identity and add typed ability flags for agreed effects. |
| Pressure if the board stays as it is | Signed effective Military margin to the war threshold, conditional point and resource exposure after Stability, and Food surplus or shortfall under frozen-board resolution. Show which components are known and which depend on choices or unavailable rules. Add revealed event conditions and margins, Books rank at an even-round boundary, and projected player order in a subsequent feature group. |
| Ways to change the position | An idle Worker, an owned Military slot with room, and the Stone cost and strength gain of a single available deployment. Combine those into whether the current war gap is closable in one deployment and the cheapest known cost. A legal purchase can create that option on its resulting board. Actual turn status indicates whether the owner can still use it. |

Keep current resources in the board facts. Name forecast values as
conditional and mark which round effects are still pending. A Military
purchase can leave the current war gap open and make next-turn recovery
feasible at the same time. The value head should be able to represent both
facts in one open position. Test the immediate deployment opportunity by
checking the owned slots and their conditions, without unrolling future
actions. In the Dutch Liberation War replay `d7a6d64a24d45218-1`, the Ranger
purchase at decision 297 left Military at 1 against a threshold of 2. The
opponent took a turn, then the Ranger deployment at decision 302 raised
Military to 7. This is a replay fixture for the distinction between current
exposure and a viable recovery option.

Record unknown separately from an unavailable action or a zero loss.
Include a distinct pre-event Food balance if exact event or war changes
cannot be established. Evaluate order and event thresholds using the actual
rule and tie semantics for that player count.

Give the candidate head own-action facts such as immediate stock and
production deltas, completion of a project, changes in conditional exposure,
and opportunities the move creates. Record choices with unresolved outcomes
as such, or use the agreed bounded follow-up enumeration for that action.
Keep a stable board representation for the value head so a synthetic menu
does not change the value of an otherwise identical handoff. Prompts and
legal move details still matter to the policy head.

Start with board facts, war pressure, one-deploy recovery, and Food balance.
Verify feature parity for the same saved snapshots in training and live
inference, including missing fields. Compare original and enriched encodings
with the same data and training budget. Check Great Wall-style progress and
war-threshold cases in held-out replays, including a vulnerable board where
the player still has an affordable deployment and the matching board after
that player passes. Compare direct play against the earlier checkpoint with
matched seeds and swapped seats, then add the same width-two search to both
to measure how much of any change comes from scoring the board.

### Direct-play encoding pilot

The first encoding experiment uses only the board and legal menu at the
decision. It adds typed move quantities, live construction and deployment
progress, slot-specific card profiles, unclipped Books and resource gaps,
and printed war penalties with current Military margins. Both arms retain
the checkpoint's categorical inputs so the new weights can be initialized
at zero and compared from equivalent starting predictions.

Fine-tune both arms from the selected 10,000-game checkpoint over the same
sample of human replay decisions, then play each against that checkpoint
and against each other. Both players choose their top legal move on
supported prompts. Both use the same static scorer on unsupported menus.
Compare paired boards with seats swapped. The pilot adds no forecasts,
move simulations, or search. It is an offline two-player experiment.

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/compare_position_encoding.py --output .data/nations-rl/current-position-pilot-v1
```

The pilot fine-tuned over 12,000 human choices for two epochs. Initial
policy and value outputs matched the frozen checkpoint on 64 validation
positions before training. On 2,400 held-out human decisions, top-choice
agreement was 38.3% for the frozen checkpoint, 44.4% for the fine-tuned
control, and 44.1% for the structured model. The structured model had
slightly lower action log loss than the control (1.624 vs 1.634).

| Direct-play pairing | Wins | Mean VP margin |
| --- | ---: | ---: |
| Structured vs. 10,000-game checkpoint | 12 / 32 | −4.38 |
| Fine-tuned control vs. 10,000-game checkpoint | 8 / 32 | −6.94 |
| Structured vs. fine-tuned control | 14 / 32 | −2.38 |

All 96 games finished. Each pairing used the same 16 boards and both seats.
Against the frozen benchmark, the structured arm gained 12.5 percentage
points over the fine-tuned control, with a paired-board 95% interval from
−3.1 to +28.1 points. The direct matchup between the fine-tuned arms also
leaves the encoding advantage uncertain. The frozen checkpoint showed
stronger play than either fine-tuned arm on these boards.

The dense experimental encoder has 350,226 trainable parameters versus
215,874 for the frozen checkpoint. It uses a separate offline checkpoint
schema. Training metrics, replays and results are under
`.data/nations-rl/current-position-pilot-v1/`.

### Matched self-play follow-up

Restart both encodings from the frozen 10,000-game checkpoint for the
PPO comparison. Both seats collect a trajectory with the current policy
of their arm. The two arms use identical board seeds, sampling seeds,
rules, game budgets and optimizer settings. The 96 games per arm are
split into two updates of 48 games. Evaluation remains direct play.

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/train_position_selfplay.py --output .data/nations-rl/current-position-selfplay-v1
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/compare_position_encoding.py --output .data/nations-rl/current-position-selfplay-v1 --evaluate-only --boards 24 --workers 4 --seed 181131
```

Six independent game workers collected all 192 games in 48.2 seconds.
The machine's eight CPU cores averaged 82% utilization during collection
and touched 100%. At least 14.3 GiB of memory remained available.
The two optimizer updates took another 9.9 seconds in total. This run
used CPU-only PyTorch. The four-thread direct evaluation averaged 22%
whole-machine CPU utilization and reached 55%, leaving more room to
parallelize evaluation than game collection.

| Direct-play pairing | Wins | Mean VP margin |
| --- | ---: | ---: |
| Structured PPO vs. frozen benchmark | 24 / 48 | −0.46 |
| Control PPO vs. frozen benchmark | 23 / 48 | +0.02 |
| Structured PPO vs. control PPO | 26 / 48 | +0.63 |

All 144 evaluation games finished, with both seats played on 24 boards
disjoint from training and from the earlier encoding pilot. The structured
model's 54.2% head-to-head win rate against the matched control had a
paired-board 95% interval of 41.7–66.7%. The sample leaves a playing-
strength difference unresolved. Logs, telemetry and replays are under
`.data/nations-rl/current-position-selfplay-v1/`.

### Structured scorer at 2,000 self-play games

Continue the structured scorer from its 96-game PPO checkpoint for 1,904
additional games. Use the same frozen 10,000-game policy as the PPO
regularization anchor and the evaluation opponent. Initialize a fresh
Adam optimizer because the pilot checkpoint stores weights only.
Keep the default 48-game update size and save a resumable checkpoint at
each update. Only the structured scorer receives further training.

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/continue_position_selfplay.py --output .data/nations-rl/current-position-2000-v1
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/compare_position_encoding.py --output .data/nations-rl/current-position-2000-v1 --evaluate-only --benchmark-only --boards 64 --seed 181136 --workers 4
```

Evaluate both seats on each of 64 fresh boards, choosing the top legal
move from the scorer, with the same static fallback for unsupported
menus. No forecasting or search is used in the comparison.

The continuation finished all 1,904 games in 4 minutes 56 seconds across
40 PPO updates and collected 336,679 decision samples. The structured
model won **81 of 128 games (63.3%)** against the frozen benchmark and
averaged **+2.34 VP**. By seat it won 41 of 64 and 40 of 64 games. The
paired-board 95% bootstrap intervals were 54.7–71.9% for wins and
+0.78 to +3.91 VP for mean margin. All evaluation games completed.

The run verifies that the trained structured scorer beats the frozen
checkpoint on this two-player direct-play benchmark. Both the encoding
and the added self-play distinguish the checkpoints in this comparison.
The benchmark hash was unchanged. The final checkpoint, training
history, evaluation results and replays are under
`.data/nations-rl/current-position-2000-v1/`.

### Scaling the structured scorer in 2,000-game batches

Resume the structured scorer and Adam optimizer from the 2,000-game run.
Train for a maximum of 10,000 additional games. At each 2,000-game
boundary, replay the fixed 64-board direct-play benchmark against the
frozen 10,000-game checkpoint, swapping seats. A batch improves on the
best earlier checkpoint if it wins more games, with mean VP margin as
the tiebreaker. Two consecutive batches without a new best stop training.
The best checkpoint is selected before evaluating it on another 64
boards that were reserved for final verification.

The run stopped after 4,000 additional completed training games, at
6,000 total. One training attempt encountered an empty legal menu,
and a replacement game filled the batch. All evaluation games finished.

| Checkpoint | Wins on the fixed benchmark | Mean VP margin |
| --- | ---: | ---: |
| 2,000 games, selected | 81 / 128 | +2.34 |
| 4,000 games | 70 / 128 | +1.73 |
| 6,000 games | 78 / 128 | +3.51 |

On 64 separate boards with seats swapped, the selected 2,000-game
checkpoint went 76–52 (59.4%) with a +2.73 VP mean margin. The 95%
paired-board interval for the win rate was 50.8–68.0%. It retained the
same weights as the original 2,000-game checkpoint.

The checkpoints, evaluation replays and stopping decision are under
`.data/nations-rl/current-position-scale-v1/`.

### Comparison on 256 additional boards

Each checkpoint played the frozen benchmark in both seats on the same
256 new boards. All 1,536 games completed in direct play.

| Checkpoint | Wins | Win rate | Mean VP margin |
| --- | ---: | ---: | ---: |
| 2,000 games | 295 / 512 | 57.6% | +1.90 |
| 4,000 games | 298 / 512 | 58.2% | +1.81 |
| 6,000 games | 300 / 512 | 58.6% | +2.35 |

Each checkpoint beat the benchmark. The paired estimate for 6,000 versus
2,000 games was +1.0 percentage point in win rate (95% interval −4.5 to
+6.4) and +0.45 VP (−0.62 to +1.46). All three paired win-rate differences
had intervals spanning zero. The run leaves the checkpoints' relative
strength unresolved. Results and all replays are under
`.data/nations-rl/current-position-256-boards-v1/`.

### Microsearch on the 6,000-game checkpoint

Replay the same 256 boards in both seats against the frozen benchmark.
Use the structured checkpoint's policy head to choose the top two
branches and its value head to compare compatible handoff positions.
Retain the previously tested depth of three main actions, 40-node cap,
and 280 ms decision budget. Small follow-up menus are considered in
full. Stop at opponent control or the start of round resolution. Score
those leaves without applying the pending round effects. Compare each
result with the existing direct-play result for the same board and seat.

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/compare_position_microsearch.py --output .data/nations-rl/current-position-6000-micro-512-v1 --workers 6
```

All 512 games completed on the exact direct-play seeds and seats.
Microsearch won 255/512 (49.8%) and averaged −0.29 VP against the frozen
benchmark. Direct play won 300/512 (58.6%) and averaged +2.35 VP. The
paired change was −8.8 percentage points in win rate (95% interval
−14.5 to −2.9 points) and −2.64 VP (−3.79 to −1.49). Search changed
9,163 of 32,846 first moves (27.9%) and hit a decision budget in 14,540
attempts (44.3%). Mean game duration rose from 0.46 to 13.28 seconds.
The benchmark took 20 minutes 14 seconds with six workers. The full
report and replays are under
`.data/nations-rl/current-position-6000-micro-512-v1/`.

Direct play takes the policy head's top move at each real prompt. A
width-one rollout that makes the same choice at every follow-up simply
precomputes those moves. The current width-two search compares completed
lines by their highest predicted win probability from the separate
value head. This can reward errors in that head, especially on the
synthetic Pass-only handoff prompt. Changing only the legal menu to
Pass shifted the 6,000-game model's estimate by 4.7 percentage points
on average across 30 round-four positions sampled from replays won by
direct play and lost by microsearch. This measures menu sensitivity
in that sample.

At round-eight decision 422 of `ef499d8c42e7d944-1.replay`, the
diagnostic re-search used the normal node cap and a longer time limit.
It preferred transferring a Worker from BM1 to BM2 and then passing
(83.6% estimated win probability) to passing directly (80.6%).
The transfer raised Military from 21 to 28, below the Opium War
threshold of 40. With the same resolution-choice scorer, the engine
finished the transfer line at −5 VP and the direct Pass line at −3
VP. The archived match itself passed, and a rerun with the standard
search deadline hit its budget. The example isolates a leaf ordering
error and does not establish the cause of the aggregate regression.

### Greedy one-action value training

At each ordinary action prompt, apply each legal action on an isolated copy
of the visible engine state and batch-score the resulting boards from the
actor's perspective with one value network. Execute the highest-valued
action. A one-action evaluation stops before another voluntary action, a
rival turn, or round resolution. The same static scorer settles choices
within an action; the frozen policy remains available for draft, growth
and prompts outside this prototype. Hidden cards and RNG are blocked in
the copies. Use the terminal winner as the target for the executed
afterstates. There is no legal-menu input to the value estimator.

On 12 archived direct-play games, the engine offered about 1,397
candidates per game. The forked board matched the real board after all
112 checked actions. The 1,157 sampled candidate applications averaged
1.58 ms per candidate before network scoring.

The inherited value head passed on the first action in 56 of 64 rounds
against the frozen benchmark. It lost all eight initial seat-swapped
games, averaging −32.13 VP, and the 12-game pure greedy pilot left
those results unchanged. A separate warm-up used 18,786 actually executed
afterstates from 128 earlier strong replays. It moved the average test
margin to −29.50 VP, with zero wins; a further 48 greedy games left
those eight test results unchanged. This is a greedy-data coverage risk
for the full training experiment.

In the one-action prototype, Pass changes pass status and fires its
immediate hooks. The scored snapshot is still in the action phase.
The probe on round 2 of `worker-00-147f84b9acae1dd0-0.replay`
observed 7 Food before and after the last Pass. The real engine added
8 Food once in production. In the 64-game pre-training evaluation,
440 of the 441 first-action passes occurred with the rival still
active. Resolving only round-closing passes would leave almost all
of those early-pass decisions on the open-board path.

For a phase-aware value model, resolve a last Pass through the known
round effects once. Use exact final scoring in round 8. After an
earlier Pass, retain the open board and represent an immediate
end-of-round projection as conditional. Keep production rates as
capacity for future rounds when scoring an already resolved board.
Mark current-round production and other effects as resolved so that
they have a different meaning from the pending effects on open
boards. Train on both states before evaluating candidates across
that boundary.

```powershell
& .data/nations-rl/.venv/Scripts/python.exe -B experiments/nations-rl/afterstate_pilot.py --initial .data/nations-rl/current-position-afterstate-warm-v1/value.pt --output .data/nations-rl/current-position-afterstate-10000-v1 --games 10000 --games-per-update 200 --boards 32 --workers 6 --seed 181148
```

The run finished at 10,000 greedy self-play games, including the
48-game warm pilot. All 9,952 continuation games completed and supplied
697,126 played afterstates. No end-of-round features or resolution
were added to the one-action scorer during this run.

| Value network | Wins vs. frozen benchmark | Mean VP margin | First-action passes |
| --- | ---: | ---: | ---: |
| Before continuation | 0 / 64 | −32.28 | 441 / 512 |
| After 10,000 games | 25 / 64 | −3.41 | 2 / 512 |

Both evaluations played the same 32 boards from both seats. The final
win rate was 39.1%, with a paired-board 95% interval of 28.1–50.0%.
The trained scorer learned to continue playing in most rounds, and the
frozen benchmark won the majority of games in the final sample. The
run took 58 minutes 38 seconds, including both evaluations. The final
single-network checkpoint and results are under
`.data/nations-rl/current-position-afterstate-10000-v1/`.

The timed continuation restored the 10,000-game weights and optimizer.
It added 5,200 completed self-play games and 643,848 afterstates in
51 minutes 15 seconds. On the same 32 boards from both seats, the
new checkpoint won 28 of 64 games and averaged −1.89 VP, up from
25 wins and −3.41 VP. The paired gain was +4.7 percentage points
(95% interval −10.9 to +18.8) and +1.52 VP (−1.11 to +3.98).
The saved model and evaluation are under
`.data/nations-rl/current-position-afterstate-50min-v1/`.

### Special abilities in the current value inputs

The 10,000-game value checkpoint reads the same structured board as
the direct-play pilot. Advisors and Wonders are identified by their
card and owner slot, with printed attributes and, for owned slots,
live construction or exploration progress, private Architects,
markers, stored Food/Stone/Gold, and the engine's public `global`
marker. The encoder adds five per-player presence flags for Sun Tzu,
Machiavelli, Great Wall, Koryo Kingdom and Joseon Kingdom. These flags
describe card presence. A forked action can apply engine-triggered
changes to the public board immediately, such as completing a Wonder.

The engine implements abilities through registered triggers whose
conditions and effects differ by card. The public `global` marker
identifies a marked card but carries no trigger, amount, duration or
target. Martin Luther adds 4 Food to each defeated player's war loss;
Mongolia adds 2 of the war's penalty resource. Songhai Empire adds 3
Food to an eligible rival's famine. In the checkpoint, the numeric
war inputs still use the printed penalty and the raw Military gap;
the event input is the ID and famine magnitude. The full structured
war and event forecast described below remains a design for a later
encoder, beyond the one-action experiment.

Controlled comparisons against the saved value checkpoint confirmed
that one and three remaining actions encode identically; zero and one
are distinguishable. This hides some of Wardenclyffe's immediate gain.
Changing only `passed_first` with Great Wall present also encodes
identically. Toggling the `global` marker on an owned Martin Luther
changes one numeric field, while the printed war features stay fixed.

The next feature group should express effects in game terms. For
quantifiable effects, supply an effective amount per affected player
and resource, with timing and eligibility where they matter. Relevant
examples are the extra war loss from Martin Luther, Great Wall's
defeat-point exemption once the owner passes first, and Vesuvius's
Worker return on even rounds. Keep effects that already ran in the
actual afterstate. For opportunities such as Sun Tzu, Wardenclyffe and
Zhu Xi, provide the action allowance or unused slot when known, and
preserve a distinct unknown state for unavailable public counters.
Keep capabilities such as Machiavelli's event choice as typed flags
where their value depends on unknown future draws.

Build those facts from one public-position interface used by both
training and inference. Validate the resulting features against the
engine's transitions and preserve owner, affected player and timing
across both settings. Pass order, Worker pools and deficit history are
already present in local snapshots; exact action counters require the
local engine or enough public play history to derive them.

### Current-round and future-round ability valuation

Use the real afterstate and the current-round forecast to account for
effects through the next resolution. Carry immediate outcomes in
resources, points, capacity and card state. Treat later choices as
opportunities when their execution is still uncertain.

Prefer learned future values. Give each special Wonder or Natural
Wonder a stable feature for each owner, then let the state-value model
learn its effect in combination with round, resources, production,
points, rank margins and other cards. Keep the rules in the engine.
Represent construction separately from active ownership and include
known availability, charges and remaining stages. For example, an
active Petra is more valuable this round when its owner can still act,
has Food to spend, and can overtake a rival with 3 Books. A completed
Sankore has already delivered its payout, while its unfinished project
still has a completion opportunity. For Vesuvius, apply the Worker
return mechanically where the current forecast reaches it and let the
model learn the cost of later returns.

Start this experiment with the direct policy. It uses one public board
observation and scores the legal menu in a batch. Self-play samples from
those scores for exploration and the engine executes the selected move.
Evaluation takes the highest score. The value head serves as the PPO
critic during training.

The two-player ability encoder extends the 6,000-game policy with
per-card flags for Advisors, Dynasties, Wonders and Natural Wonders
with a printed or structured ability. For each player it distinguishes
active cards, projects and engine-reported global effects. It also
includes first-pass status, the acting player's offered special
actions and the ability targeted by each legal move where identified.
The policy can combine these inputs with existing production, stocks,
points, card progress and round. New weights start at zero so the
starting policy retains its learned scores. The experiment leaves
timing and effects to the engine and assigns no fixed VP values.
The earlier review values can still serve as sanity checks.

Measure the flags' effect with equally trained versions of the same
starting policy on the same boards with seats swapped. Use the same
optimizer initialization for both versions. Record move-selection
speed and per-ability coverage alongside wins and VP margins.

The first experiment added 1,000 two-player self-play games per arm.
Both arms continued from the same 6,000-game checkpoint with a fresh
Adam optimizer and the same training seeds. Against the frozen
10,000-game benchmark on 128 archived boards played in both seats,
the starting policy won 155 of 256 games (+2.44 VP), the continued
control won 158 (+2.58 VP), and the ability policy won 148 (+1.60 VP).
The paired difference for the ability policy was −3.9 percentage
points (95% interval −10.9 to +3.1) and −0.98 VP (−2.26 to +0.36).
Each of the 134 ability cards had at least one input weight change
from its initial zero. The experiment has yet to show a strength gain.

The replacement experiment removes the corresponding legacy identity
tokens for owned cards, market cards, unplayed dynasties, and legal
moves. It also zeros the five overlapping legacy ability indicators.
Card profiles and public progress numbers remain available. A choice
such as hiring from a named wonder uses its ability flag for the
source and the project's flag for the target. The frozen training
reference and match opponent still use their original observations.
Measure the policy both immediately after replacing the identities
and after 1,000 self-play games, using the same boards as before.

The replacement won 109 of 256 games (−1.39 VP) before training and
122 (−0.83 VP) afterward. On the same boards, the additive ability
policy won 148 (+1.60 VP) and the continued control won 158 (+2.58 VP).
The trained replacement trailed the additive policy by 10.2 percentage
points (paired 95% interval −18.4 to −2.0) and 2.43 VP (−3.92 to −0.98).
Market cards and unplayed dynasties have card-specific ability inputs
when they are legal targets for the acting player. Their full board
inventory uses the remaining public features. This experiment tests
replacement in a warm-started policy after 1,000 additional games.

The replacement policy then continued for another 10,000 self-play
games with its optimizer state preserved. Each 1,000-game checkpoint
was evaluated against the frozen 10,000-game benchmark on the same
128 boards in both seats. The final checkpoint won 162 of 256 games
(63.3%, +2.80 VP). The checkpoint after 9,000 additional games led
on wins with 165 of 256 (64.5%, +2.73 VP) and was selected by that
criterion. On 128 fresh boards, the selected checkpoint also won
165 of 256 (+3.66 VP), compared with 122 of 256 (−0.28 VP) for the
starting replacement checkpoint. The paired changes were +16.8
percentage points (95% interval +9.0 to +24.6) and +3.94 VP
(+2.57 to +5.38). This measures the gain from continued training
within the replacement encoding. The earlier control with card IDs
had received fewer self-play games.

The next continuation used 1,000-game batches and a three-batch
patience limit, with a ceiling of 50,000 total games. The 17,000-game
checkpoint already counted as the first batch below the 16,000-game
best. The next two checkpoints won 150 and 157 of 256 games, so
training stopped at 19,000. The 19,000-game checkpoint had a higher
mean VP margin (+2.88 versus +2.73), while the 16,000-game checkpoint
retained the better win count (165 versus 157). The selected
16,000-game checkpoint won 155 of 256 games (+2.03 VP) on a second
set of 128 fresh boards.

The next run reset the same three-batch limit whenever a checkpoint
set a new win-rate or mean VP record. The 19,000-game checkpoint
already held the VP record at +2.88. The replacement policy trained
for another 18,000 completed games and stopped at 37,000 after the
35,000-, 36,000- and 37,000-game checkpoints all fell short of both
records. The selected 34,000-game checkpoint led both measures with
196 of 256 wins (76.6%) and +6.15 VP. It won 188 of 256 games (73.4%)
with a +4.91 VP margin on 128 fresh boards played in both seats.
Three training attempts with no legal engine move were replaced.

A follow-up evaluated the 34,000- through 37,000-game checkpoints
on 384 additional two-player boards in both seats against the frozen
benchmark. The respective results were 570, 577, 568, and 530 wins
out of 768, with mean VP margins of +5.60, +5.88, +5.38, and +4.30.
The 35,000-game checkpoint led the fresh sample. Paired intervals
overlap zero for each comparison within the top three. Its advantage
over the 37,000-game checkpoint is +6.1 percentage points and +1.57 VP.
Across the shared 1,024 benchmark games including the original
monitoring boards, the 34,000- and 35,000-game checkpoints were one
win apart (766 and 765 respectively), with the higher mean VP
margin at 35,000 (+5.87 versus +5.73).

### Top-two reading with the 35,000-game baseline

Use the 35,000-game replacement-policy checkpoint from
`.data/nations-rl/ability-replacement-scale-either-v1/benchmarks/games-035000/structured.pt`
as the direct-play baseline. Its frozen benchmark identity is recorded
in `.data/nations-rl/ability-replacement-last-four-768-v1/manifest.json`.
The checkpoint sees projected production, war strength and penalties,
and famine size. The full event and round-resolution forecast remains
outside its trained input schema.

Rank legal actions with the policy head at each real prompt. Search
the top two ordinary actions and resolve small follow-up menus in
full. Reuse the worker-transfer rules and resource dominance within
each root branch. Stop before another player acts, a hidden draw
occurs, or round production begins. Back up the shared network's win
estimate from the last supported pre-move prompt on each completed
line. Use the original policy rank for ties, including when both
roots hand off immediately. Revert to direct play if the two roots
cannot be compared within 64 branch replays and a 450 ms budget.

Run the local comparison with
`compare_position_microsearch.py --pre-move --output <directory>`.
Both the direct reference and the reading version use the 35,000-game
weights. The test compares them on the same boards against the same
frozen opponent.

The 10-game smoke test completed all games. Reading won 6 games
(+4.20 VP) and direct play won 5 (+1.80 VP) on the same boards.
Reading changed 69 of 519 searched decisions and hit the branch
budget on 133. The sample verifies the integration and leaves the
strength comparison open.

The 100-game comparison retained the 10 smoke games and added
45 more boards played in both seats. Reading won 71 of 100 games
(+5.26 VP) and direct play won 74 (+5.39 VP) against the frozen
benchmark. The paired changes were −3 percentage points
(95% interval −14 to +8) and −0.13 VP (−1.96 to +1.71).
The search hit its 64-branch or 450 ms limit on 2,070 of 6,060
searched decisions (34.2%). Measured decision time was 219 ms
at the median and 467 ms at the 95th percentile.

The best-first variant inspects both root choices before taking the
highest-valued reached position from a shared queue. It uses the
policy to order choices at each prompt and uses the same network's
win estimate to compare positions across branches. Small follow-up
menus remain fully eligible. At cutoff it can play a completed
handoff line or follow the strongest reached position and search
again at its recorded prompt. Direct play is the fallback when no
complete or resumable line has been reached. The 64-branch and
450 ms budget applies to each search, including resumptions.

On the same 100 games, best-first won 73 (+5.33 VP), compared
with 71 (+5.26 VP) for depth-first and 74 (+5.39 VP) for direct
play. Its paired gains over depth-first were +2 percentage points
(95% interval −7 to +11) and +0.07 VP (−1.38 to +1.59). Best-first
hit the limit on 1,422 of 5,398 searches (26.3%) and kept a usable
line at every cutoff. It resumed from a reached prompt 96 times.
Mean game time fell from 15.59 to 12.46 seconds under the same
worker and search budgets. Re-rooting skips earlier decision
branches, while individual engine branches still replay their
prefix to reconstruct the board.

The extended top-two best-first benchmark added 400 games, for
500 games across 250 boards played in both seats. Best-first
won 349 (+4.39 VP) and direct play won 378 (+5.89 VP).
The paired differences were −5.8 percentage points (95% interval
−10.2 to −1.4) and −1.51 VP (−2.38 to −0.64). It used a
line at all 6,563 hard cutoffs out of 26,444 searches.

The broad best-first variant queues every eligible move with its
parent position's win estimate as the initial priority. The
policy orders moves within each prompt. A move inherits that
priority until its successor is reached and evaluated. This
heuristic is used for ordering and stopping. Stop if the next
queued priority trails the best reached estimate by more than
five percentage points. Keep the same time and branch limits,
and retain a line at cutoff as in top-two best-first.

On the same 500 games, broad best-first won 81 (16.2%, −9.35 VP).
Compared with top-two best-first, the paired differences were
−53.6 percentage points (95% interval −58.4 to −48.8) and
−13.73 VP (−14.65 to −12.78). It inspected more than two root
moves in 97.1% of ordinary action searches. Hard limits stopped
71.0% of searches, and the score gap stopped another 11.9%.
It changed the policy move on 42.9% of searched decisions,
compared with 17.6% for top-two. Mean game time was 17.55 seconds
for broad search and 11.85 seconds for top-two. All games completed.

The parity audit replayed 24 completed games from the top-two and
broad runs through the live move callback. It then replayed the same
committed paths through the search transition. All 1,655 public
observations matched, through eight branch choices. At 331 supported
prompts the encoded inputs, legal move ordering, policy logits and
value logits were equal, including 132 prompts at depth two or later.

Keeping the ordinary search rules and narrowing main prompts to one
move gave 8 identical replays out of 20. Six first differences
followed undeploys because the search required a redeploy. Three
replaced confirmation with an undeploy, two came from searched
Turmoil follow-ups, and one came from a Natural Wonder placement.
Strict width one used the direct baseline's decision at every prompt,
including confirmation and fallback, with worker pruning disabled.
It reproduced all 20 direct replays, covering 7,826 decisions and
matching the final scores in each game. These checks establish
transition and scoring parity for the sampled prompts. They do not
measure the accuracy of the win estimate for comparing branches.

### Standalone undeploy and shared position deduplication

Treat undeploy as an ordinary legal action. The engine determines
what can follow it, including a purchase, Turmoil, confirmation, or
a deployment. Share exact positions across root moves. The key
includes the player's resources, board, legal menu, turn counters,
remaining actions, and registered effects. Deduplicate ordinary
action and confirmation prompts and known handoffs. Wait for the
engine to resolve small prompts with pending card or event effects
before merging their outcomes. The separate resource-dominance
heuristic still applies within a root branch.

Record each observed incoming move even when a position has already
been searched. Reconstruct the selected line from the shortest route
through those moves, including the correct prompt number for resuming
an unfinished line. A later discovery can shorten an already-scored
continuation. In the Brewery-to-Lyceum fixture, the two paths merge
after placing Lyceum and the canonical route omits the extra undeploy.

Strict top-one matched all 20 direct-play replays and all 7,826
decisions after the change. A 10-game top-two smoke test completed
all games and merged 1,873 duplicate positions. It hit the search
budget on 406 of 508 searches. The small sample checks integration
and leaves the strength comparison open.

With the frozen 35,000-game policy, the 500-game benchmark of
standalone undeploy and shared position deduplication won 354 games
(70.8%, +4.48 VP) across 250 seat-swapped boards. Previous top-two
won 349 (+4.39 VP). The paired difference was +1.0 percentage point
(95% interval −3.4 to +5.2) and +0.10 VP (−0.77 to +0.97).
Direct play won 378 (+5.89 VP), leaving revised top-two behind by
4.8 points (−9.6 to −0.2) and 1.41 VP (−2.42 to −0.42).
The revised search found 117,653 duplicate positions. It hit the
same search limit in 83.0% of searches versus 24.8% for previous
top-two. Mean game duration increased from 11.85 to 22.14 seconds.

### Direct training with normalized wonder slots

Warm-start from the 35,000-game replacement-policy checkpoint and
train the normalized wonder-slot encoder for 20,000 additional games.
Training samples moves from the direct policy for PPO exploration.
Benchmark play uses the highest-scoring move. Every 2,000 games,
measure the checkpoint against the frozen 10,000-game opponent on
50 monitoring boards from both seats.

The final normalized checkpoint led the monitoring set with 73 of
100 wins (+5.90 VP), compared with 71 (+5.17 VP) for the starting
policy. On a separate 50-board holdout it won 84 (+7.42 VP), compared
with 76 (+6.23 VP) for the starting policy. Paired holdout changes
were +8 percentage points (95% interval −2 to +19) and +1.19 VP
(−1.14 to +3.76). The comparison includes both normalization and
the additional training.

The normalized policy resumed at 55,000 total games with optimizer
state preserved. Each 5,000-game batch used a 200-game monitor on
100 boards in both seats. A new win or VP record reset the
three-batch stopping count. Training stopped at 90,000 games after
35,000 more completed games and two replaced engine failures.
The 75,000 checkpoint won the most games on the monitor (159 of
200, +6.12 VP); the 65,000 checkpoint had the highest VP margin
(152 wins, +7.02 VP). On the same 200 fresh holdout games, the
starting checkpoint won 157 (+7.41 VP), the 65,000 checkpoint won
160 (+7.07 VP), and the 75,000 checkpoint won 149 (+5.91 VP).
The 65,000 checkpoint's paired changes against the start were
+1.5 percentage points (95% interval −6.5 to +10.0) and −0.35 VP
(−1.97 to +1.30).

A direct-play round-robin used 100 fresh boards and both seats
for each pairing. The 75,000-game checkpoint beat the 55,000-game
checkpoint 108–92 (+1.39 VP) and the 65,000-game checkpoint 102–98
(+0.38 VP). The 65,000-game checkpoint beat the 55,000-game
checkpoint 104–96 (+0.61 VP). Overall win counts were 210, 202,
and 188 out of 400 for the 75,000-, 65,000-, and 55,000-game
checkpoints. All paired win-rate intervals included 50%.

The 75,000-game policy became the frozen head-to-head baseline for
the mixed-settings continuation. The mixed encoder warm-started
from its weights and used the diversified two-player rules for both
training and evaluation. Each 5,000-game batch used 256 direct-play
benchmark games on 128 boards in both seats. The stop rule allowed
five to ten batches and reset the three-batch count for a new win
or VP record. It stopped after eight batches at 115,000 total games.

The 90,000-game checkpoint led the monitor on wins (156 of 256),
and the 100,000-game checkpoint led on VP (+2.36, 155 wins). On
fresh matched boards against the same 75,000-game opponent, the
90,000-game checkpoint won 139 of 256 (+0.82 VP) and the
100,000-game checkpoint won 155 (+2.05 VP). The latter's paired
95% intervals were 54.7–66.4% for wins and +0.91 to +3.15 VP.
Ten failed training attempts were replaced.

The 90K and 100K checkpoints then played directly against each
other on 512 mixed-settings boards in both seats. The 100K
checkpoint won the first 256 games 130–126 and the next 768
417–351. Across all 1,024 games it won 547–477 (53.4%, paired
95% interval 50.3–56.5%) and averaged +0.83 VP (+0.24 to +1.42).
Its largest margins came on Emperor and Prince boards.

### Search with the 100K baseline

The 100K mixed-settings checkpoint at
`.data/nations-rl/mixed-settings-75000-batches-v1/benchmarks/games-100000/structured.pt`
is the local direct-play baseline for search experiments. Its weights
and the 90K opponent are pinned by hash in the benchmark manifests.

Replay the archived mixed-settings boards under their original rules
and pass the actual growth allowances and weighted-draw setting to
the policy at simulated prompts. Use the same 100K policy for move
ranking and the win estimate. Strict top-one reproduced all 32
direct-play replays and all 11,616 decisions against 90K.

On 128 archived mixed-settings boards with both seats, 100K direct
play beat 90K in 144 of 256 games (+1.11 VP). Top-two best-first
with the same 100K weights won 125 (−0.41 VP). The paired changes
were −7.4 percentage points (95% interval −15.2 to +0.4) and
−1.52 VP (−2.91 to −0.09). With 64 branch replays or 450 ms per
search, 84.6% of searches hit the limit and 18.9% changed the first
move. Mean game time was 22.89 seconds with search and 0.54 with
direct play. All games completed.

A continuation audit sampled one reproduced first-move override from
each of the 128 benchmark boards. It committed the search line or
the direct line from the same public prompt and game seed, then
finished with direct 100K play on both seats. All 256 rollouts
completed. Each choice won 63 games. Search changed ten losses to
wins and ten wins to losses. Its VP margin was lower by 0.98 on
average (paired 95% interval −2.19 to +0.17).

The pre-move value estimates ranked search higher on 121 of 128
positions, by 2.40 win-probability points on average within that
group. The two lines each won 56 of those games. Search improved
VP on 32, matched it on 39, and reduced it on 50, with a mean
change of −1.12 VP. The comparison includes 21 prefixes chosen at
the budget cutoff. The remaining 107 lines reached a handoff and
averaged −0.91 VP. These are deterministic paired rollouts under
one continuation policy. The pre-move estimates can come from
different prompts or before different amounts of the turn have
resolved.

Rescoring the same 128 pairs after the last move fully resolved
improved VP ranking from 32 to 44 correct out of 84 pairs with
different VP outcomes. Win ranking improved from 10 to 12 correct
out of 20 pairs with different winners. The 21 cutoff prefixes
were completed to handoff using the recorded direct-policy moves.
Each pair stopped at the same kind of boundary, either before the
opponent's turn (78) or before round resolution (50). The frozen
head scored from the original player's perspective with identical
placeholder action menus. It was trained on real decision prompts.

Using the handoff score in top-two best-first search won 112 of
256 games (43.8%, −1.96 VP) against 90K on the same mixed settings.
Direct play won 144 (+1.11 VP), and pre-move top-two won 125
(−0.41 VP). The paired handoff-score change was −12.5 percentage
points (95% interval −20.7 to −4.3) and −3.07 VP (−4.80 to −1.46)
against direct play. Against pre-move top-two it was −5.1 points
(−12.5 to +2.7) and −1.55 VP (−3.23 to +0.07).
This search preferred a scored handoff when available and retained
the existing pre-move fallback when none was available. It changed
the policy's first move in 30.2% of searches versus 18.9% in
pre-move top-two, with the hard limits unchanged.

The 100K encoder omits the remaining main-action allowance and the
handoff observation reuses the original player's action prompt with
a placeholder menu. On an archived board, changing only the supplied
action count from 0 to 1 to 2 left the encoded inputs and win
estimate identical. The engine decrements the allowance after a
main action resolves and preserves it on undeploy. The value head
needs the perspective player, who can act next or whether resolution
comes next, and any remaining same-turn action allowance. The offline
engine can expose these fields on the same path for training and
search. Compare completed branches at handoff, and train and validate
the value head on that scoreable state before using it to override
the direct policy.

The turn-aware value pilot uses the frozen 100K board representation
and trains only a replacement win-value head. The six inputs record
whether the perspective player or rival acts next, whether round
resolution follows, whether the next turn still needs initialization,
and each player's remaining main actions. Training uses direct 100K
self-play on fresh mixed-settings boards, sampling action prompts and
turn handoffs and recording all starts of round resolution. A matched
control trains on the same boards and outcomes without the six
inputs. Epoch selection uses separate self-play validation games;
the 128 paired-continuation positions are reserved for the ranking
check. Search still uses the original 100K head.

Training used 362,862 observations from 3,000 games, with 300
separate validation games. On the 128 held-out pairs, the frozen
head ranked the higher-VP line correctly in 44 of 84 cases. The
retrained control got 43 and the turn-aware head got 41. Their
winning-line rankings were 12, 10, and 10 out of 20 respectively.
The turn-aware head improved Brier score from 0.185 to 0.166;
the retrained control was also at 0.166. Each held-out pair shared
the same turn inputs by design, with zero remaining main actions
at handoff. The test compares resolved positions and leaves open
the effect of explicitly changing action availability.

A separate holdout compared one main action remaining with zero
on 256 fresh mixed-settings boards. Both lines began at the same
prompt. One undeployed and retained control; the other took the
highest-ranked action that spends the main action and resolved it
through opponent handoff. Both seats used frozen direct 100K play
after the forced prefix. All 512 rollouts completed. When the two
lines produced different winners, the frozen head picked the
winning line in 24 of 49 pairs, the retrained control in 32, and
the turn-aware head in 34. For differing VP margins the counts
were 100, 105, and 104 out of 187. The turn-aware gain in winner
ranking was +20.4 points against the frozen head (paired 95%
interval +6.1 to +34.7) and +4.1 points against the retrained
control (−8.2 to +16.3). Board changes and turn availability
both differed between the two lines.

In top-two, the frozen 100K policy still ranks the legal moves.
The retrained heads score ordinary main-action prompts and resolved
handoffs using the same state representation used for training.
Follow-up prompts outside that training sample inherit the last
estimate for queue ordering. The turn-aware variant reads the actual
remaining allowance at main-action prompts and the next player or
round-resolution marker at handoff. Both variants prefer completed
handoffs over unfinished prefixes and use the same hard limits.

On the same 256 games against 90K, top-two with the turn-aware
head won 112 and averaged −2.52 VP. Top-two with the retrained
control won 110 and averaged −3.07 VP. The paired gain from turn
inputs was +0.8 percentage points (95% interval −5.9 to +7.4)
and +0.55 VP (−0.76 to +1.88). Direct 100K play won 144 games
at +1.11 VP, an advantage over turn-aware search of 12.5 points
and 3.62 VP. Both runs completed all 256 games.

Coverage matters for learning. In 64 benchmark replays for the
15,200-game value checkpoint, the evaluated player held 40 distinct
special Wonders or Natural Wonders at some observed action prompt.
Petra appeared in three games, Piazza San Marco in one, Sankore
University in zero, and Vesuvius in 14. These are benchmark
observations. Measure per-ability training coverage from collected
positions and use representative replays or sampling where key
abilities are sparsely observed.

The revised review workbook keeps the earlier decisions verbatim and
gives the owner new override fields for current treatment, capability,
future rule, rate and basis. Revisit older approximations when the
round forecast covers the same outcome. Versailles's former flat
penalty is replaced in the proposal by the forecast effects of forced
least Stability. Great Library's survival comes from the engine's
removal condition. Old Uppsala's potential replacement remains a later
scenario. Shwedagon Pagoda's earlier totals need a fresh estimate of
the value left after the current-round effect is covered.

## Goal and boundary

For each non-administrative legal move, assess the public position after that
move and expose a compact forecast to the experimental policy. The motivating
report is that the player frequently loses the revealed event. An event ID and
famine amount alone do not show the model how an action changes eligibility,
war loss, Food after famine, Books scoring, or next-round order.

This is a mechanical forecast with optional step 1A search up to a handoff.
It may enumerate the small subchoices of an immediate effect (which Worker
pool to take from, resource to pay, colony to remove, and similar choices) and
later same-player actions when no opponent intervenes. The later reading paths
may use the same transitions. Do not search opponent turns as part of the
initial feature calculation.

The model's training and live inference must use the same information. The
forecast may use only the position and legal options available to the live
worker, the maintained public card rules, and match settings reliably obtained
from the match webpage. The local engine can validate the forecast but its
internal counters, hidden decks, seed, and replay are not model inputs. Do not
turn an uncertain option into a fictitious exact board state. Preserve an
unknown/conditional indicator where a later choice or action matters.

The hosted player receives a current WebSocket state, not a complete replay.
The state omits `turn_number` and `remaining_main_actions`, although the engine
uses both. It can see Sun Tzu ownership and Wardenclyffe construction progress;
it cannot reliably know the remaining action allowance after a restart.
The game's offered legal options remain authoritative.

## Match settings

The match page and the authenticated match listing render immutable house rules
in their `Type` line. Managed discovery already fetches the listing; fixed-match
login already fetches the match page. Parse that line for the identified match
and normalize the rules, including `lincolnNerf`, before using a rule-sensitive
forecast. Keep `unknown` distinct from `false` if the page could not be parsed.
Use the same rule representation from replay headers for offline training.
Do not assume the public WebSocket state contains these settings.

Lincoln's standard rule takes one Worker per activation. With `lincoln_nerf`,
the action takes up to two Workers and removes Lincoln. The feature/forecast
must select the variant using the verified match setting.

## Forecast sequence and features

Tabony resolves production, normal player order, war, the two event effects in
sequence, famine, turmoil removal, and (on even rounds) Books scoring. Other
end-of-round and end-of-age hooks then fire. Event effects can alter later
eligibility or order. Match engine rules for most/least ties, resource caps,
deficits, and point losses matter; simple subtraction is insufficient.

### Compact resolution projection

Encode the current board once. For each candidate, attach per-player numeric
changes and changes tied to affected slots, plus the assumptions behind the
forecast. The simulation follows each outcome on its own board through the
remaining phases. Only the resulting features may be blended when the
forecast calls for a blend.

| Area | Projected changes |
| --- | --- |
| Resources and strength | Food, Stone, Gold, Books, Military and Stability after resolution, including temporary modifiers that expire. Recompute net production and upkeep after changes to Workers or cards. |
| Points and order | VP tokens, Books VP on even rounds, board score, and the resulting turn order after any event overrides. On round 8 use the engine's final score and placement under the match's tiebreak rules when the outcome is determined. |
| Workers and cards | Grown and idle Workers, changes to deployments and Worker pools, added or removed cards, covered slots, and Wonder or Natural Wonder progress. Carry effects triggered by project completion through the rest of the resolution. |
| Abilities and counters | Changed active effects and their scope, temporary modifiers, private Architects, held Turmoil, markers, and resources stored on cards. |
| Resolution status | Which effects have resolved and whether the game has ended. Stop before next-round setup, including market refresh, supply resets, growth, and the next event. |

Record who qualifies for each event half and which outcomes are forced,
assumed, or unknown. Use public round history when a revealed effect
depends on it, such as who bought the war or who bought the most Golden
Ages. A current-board snapshot alone may not establish those facts.

At the current first-layer width of 64, adding 25 numeric board inputs per
player adds about 3,200 weights for two players or 6,400 for four. This is a
parameter estimate for an unchanged architecture. Measure forecast cost
per candidate, especially for choices and chained card effects.

### Event identity in the scorer

Use the revealed event ID to look up its rules in the forecast. Omit the
raw event ID token from the new scorer once the structured inputs cover
its effects. Keep famine magnitude and pending status, and expose what
each event half depends on, who qualifies now, the margin to a change
in eligibility, and the resulting per-player gains or losses. Include
active hooks and public counters when they matter, and distinguish
unavailable inputs from a known zero effect.

Two events can give the same forecast on a frozen board and react
differently to another action. For example, the Stupor Mundi reward is
four Books for most Golden Age purchases this round. When nobody qualifies,
its current reward is zero, and its purchase trigger and counts still
matter to the value of a Golden Age. Carry that dependency as structured
information so the model can recognize it across events.

Train the new encoder twice with matched data and settings, with and
without the event ID. Check held-out event-sensitive move rankings and
matched-game results before dropping it from the new production model.
Existing checkpoints retain their original encoding.

### Resolution choices and signed deficits

For each candidate, forecast resolution on its resulting board with further
ordinary turns frozen. Include end-of-age scoring and hooks on rounds 2, 4,
6, and 8. At each resolution choice, compare the legal options from the
perspective of the player who makes that choice. Evaluate an option through
the remaining known phases so that delayed effects and temporary deficits
influence the choice. Apply the same rule when the chooser is an opponent.
Use the documented card preferences as provisional forecasts where the
choice evaluator lacks the relevant inputs. Mark choices and outcomes that
depend on unavailable information as conditional or unknown.

Expose resource shortfalls as signed model inputs at the phase where they
occur, before any engine deficit settlement. Keep the negative amount by
resource even if the final balance recovers. Record deficit-related VP
changes when they occur, separately from final balances and Books-scoring
gains. Respect engine exemptions, available VP, and the per-resource record
of points already lost this round. Use engine settlement internally where
it determines later effects or Books scoring. The signed feature still
records the original shortfall. If paying a deficit opens a choice among
remaining resources, expose the unallocated amount and mark affected later
balances as conditional. Enumerating all payment combinations is optional
for this forecast. Projected point totals already include any
deficit loss they reflect. Actual resources and VP remain the open-board
inputs.

Checked on the local engine with Joseon Kingdom (`K_JK`) in round 2. The
player had 2 Food before a 3-Food famine, with 2 Food deposited on Joseon
Kingdom. The forecast should preserve Food `−1` at famine and `−1 VP` from
the deficit. The engine settled Food to 0, spent 1 Book before Books scoring,
and later returned 4 Food from the dynasty. The player finished with 4 Food
and 2 VP after starting with 3 VP. A separate round-3 check with 0 starting VP
retained the same Food shortfall and payout, with a deficit VP change of 0
and no end-of-age scoring.

Calculate the following for every player and each candidate move, with the
current-position estimate and candidate delta available to the model:

- Resources and points after each relevant phase; Food after production, war,
  event, and famine; projected next-round Food stock plus production. Do not
  count production twice when moving between phase snapshots.
- War defeat status, margin to safety, Stability mitigation, resource and point
  loss, and any exemption or extra penalty from a visible card.
- Most/least Military, Stability, and Food eligibility and distance to the
  applicable threshold, using the correct tie and five-player rules.
- Normal order after production and military/stability sorting, plus any
  subsequent event-imposed order. Keep actual order separate from heuristic
  opportunity adjustments such as Buddha's effective access as last.
- Books rank and projected Books points on even rounds; signed resource
  shortfalls at each relevant phase, Books spillover, and VP losses from
  deficits, revolt, and other causes.
- Visible conditional capabilities and triggers with owner and affected-player
  scope. Exact consequences belong in the projected resources/points. Future
  opportunity flags should not be converted to invented points.

If several legal effect choices give tied preferred outcomes, blend their final
feature vectors, not physical board states (for example, do not retain half a
colony). Preserve whether a forecast used an assumption. When a player cannot
pay, has no Workers/Architects/colonies, or otherwise lacks an option, the
engine's forced outcome overrides the preference below.

## Event-choice forecast assumptions supplied by Jonas

These provisional preferences inform the event forecast when a choice
cannot yet be compared using the position evaluator.

| Events | Forecast choice |
| --- | --- |
| Bread and Games; Paper Money; Tennis Court Oath | Take the Food-for-Books/Gold exchange unless it creates a direct famine Food deficit or makes stock plus projected production negative in the next-round Food assessment. |
| Fourth Crusade | If eligible, forecast paying 3 Gold. Include the gained point and the resulting least-Military Books effect. |
| Zoroastrian Revival | Choose 4 Stone unless making others lose 3 Food would put more than half of the other players in Food deficit after famine; in that case choose the Food loss. |
| Sea Peoples | Remove an Architect if possible; otherwise take the point loss. |
| Ecological Collapse | Choose the 2 Food loss when offered; the engine forces going last below 2 Food. |
| Salem Witch Trials | Choose the 3 Gold loss when offered; use the forced advisor-removal outcome if unable to choose it. |
| Little Ice Age | Choose the 3 Food loss when offered; use the forced Books loss if unable to choose it. |
| Peace of Westphalia | Choose the 3 Gold loss when offered; use the forced Military reduction if unable to choose it. |
| Han Dynasty | Take the Worker and Food whenever offered. |
| Glorious Revolution | Take 6 Gold and go last only if already last in projected normal order; otherwise decline. |
| Janissaries | Take two Workers and Stone whenever offered. |
| Papal Indulgence; Great Exhibition | Hire free Architects whenever possible, up to the offered limit. |
| Ashoka's Conversion | Undeploy military Workers except one, preserving raid ability. |
| Mercantilism | Undeploy building Workers whose later redeployment cost is at most 2 Stone. |
| Entente Cordiale | Forecast no optional free military deployments. |
| American Revolution; March to Moscow | Remove the colony whose loss avoids a resource deficit; blend final features on a tie. |

All other event effects follow their visible mechanical conditions. Apply each
half in engine order. The owner-supplied choices are provisional and will be
checked against resolved rounds.

## Advisor forecast assumptions supplied by Jonas

For other advisors, use explicit current production, resource, rank, war, and
purchase effects from the maintained rules where these are determined by the
public board. Static card IDs alone are not a substitute for the effects.

| Advisor | Forecast rule |
| --- | --- |
| Sun Tzu | Expose extra-first-turn-action capability; no exact remaining-action count when unavailable publicly. |
| Peter the Great | Take 5 Books if it passes at least one opponent in projected Books ranking; otherwise take 5 of the scarcest resource, choosing Stone on a tie. |
| Frederic Chopin | Forecast doubled Books production if `floor(own Gold / 5) >= max(floor(opponent Gold / 5))`; this is a retention/buy-back heuristic, not a guaranteed purchase sequence. |
| Buddha | Assess action access as if last in turn order and expose a separate Buddha penalty flag for the further cost of skipping the first turn. Do not change actual order used by the rules. |
| Alhazen | Use a 1 Gold opportunity estimate; allow a separate capability flag for residual value learned from training. Resolve the swap if it is the actual chosen action, without counting the baseline estimate again. |
| Marco Polo | Enumerate the legal immediate payment/action outcomes without interleaving opponent moves. |
| Galileo Galilei | Use a 1 Gold opportunity estimate; resolve the free purchase exactly if chosen. |
| Shaka Zulu | Assume opponents buy the colonies they can currently afford; enumerate those public, immediate possibilities without interleaved turns. The buyer receives Shaka's Stone. |
| Suleiman I | Include his printed 3 Military and exhaustively resolve the immediate Worker-taking options when available. |
| Abraham Lincoln | Enumerate immediate Worker-taking outcomes without interleaved opponents, respecting the verified Lincoln house rule. |
| Simon Bolivar | Enumerate the immediate outcomes of selling each eligible colony without interleaved opponents. |
| Boudica; Hypatia | Include immediate removal when their condition is met. Value Hypatia using current Books production plus one; do not add speculative later-round value. |
| Qin Shi Huang | Include 3 Food production and a heuristic 2-Stability cost for maintaining a defensive margin. Keep that heuristic separate from physical Stability. |
| Harald Hardrada | Include immediate-removal risk when least Military. |
| Zhu Xi | Resolve a current advisor replacement as covering Zhu Xi when eligible. Otherwise expose `has_zhu_xi_slot` for the unused extra advisor capacity, along with his printed modifiers. |
| Niccolo Machiavelli | Expose a specific capability flag; hidden future event draws cannot be valued exactly from the current public position. |

An advisor's immediate chosen action uses its actual transition rather than
the general opportunity estimate. `cards[Zhu Xi].covered_by` is visible in the
card state. Peter's production choice is omitted from the engine's public
projected production, so the forecast must supply it when eligible.

## Remaining review queue

Review the remaining effects in `public-position-forecast-review.xlsx`. It has
one row per playable Wonder, Natural Wonder, Dynasty, special Golden Age,
exceptional Building/Military/starting Colony or Advisor, and nation ability.
The workbook contains source rule text, printed numeric values, a proposed
forecast, and a blank column for Jonas's decision. Basic numeric war, battle,
building, military, colony, and Golden Age values still require correct
mechanical application but generally no owner preference rule.

The local catalog contains 50 Wonder entries, but three are FAQ placeholders
for promo cards absent from the playable engine roster (Hagia Sophia, Kremlin,
Mechanical Turk). The review workbook excludes those three. It includes 19
Natural Wonders, three Golden Ages with special effects, 34 Dynasties, and 17
nations. Wardenclyffe's three-action completion trigger is included. Hidden
draws, including Victoria Falls, remain conditional rather than exact forecasts.

Statue of Liberty uses the engine's `most_least` result for grown Workers at
final scoring. With two to four players, only a sole leader gets the bonus.
With five, a sole first and sole second qualify, as do exactly two tied for
first. Players tied at second place do not qualify; three tied for first means
no qualifier. The card-specific official FAQ wording suggests a stricter
five-player interpretation, while the general five-player rule and the engine
use the top-two rule. The forecast should match the engine used for the game.

## Validation before model use

Build a versioned public-position feature encoder shared by training and live
inference. Compare forecasts with actual phase outcomes in completed replay
positions, including event choices, advisor hooks, ties, deficits, and house
rule variants. Keep the original model as a control and evaluate the new model
on held-out games and seat rotations. A good prediction of an event outcome is
separate from evidence that the resulting policy plays better against people.

Sources checked for this design: `../nations-server/Nations/nations/{match.py,
player.py,event_cards.py,progress_cards.py,dynasty_cards.py,nations.py}` at
`55d5eeffb01ecd6cb6a480221d3226511ea48d23`, plus
`live-player/{card-index.json,tabony.mjs,discovery.mjs,worker.mjs,rl-policy.mjs}`
in this checkout. The sibling engine is a local reference, not proof that the
hosted Tabony version always matches it.
