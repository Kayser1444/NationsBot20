# Nations move picker: first feature set

These features come from Kayser's review of a real decision and his approach to
assessing a round. They describe what to measure. The replay ranker and
simulations can learn when each factor matters.

## Local two-player prototype

To play in a browser, run this from NationsBot20 and open
[the local board](http://127.0.0.1:8765/).

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/serve-nations.py
```

The browser board uses the local engine and the card images available in the
checkout. Click a card for its details, or choose a move from the action panel.
NationsBot responds automatically. The game resumes from
`.data/nations-play/browser.replay` after a reload or server restart. Save a
replay from the toolbar before starting a new game if you want to keep it.

The prototype runs on Tabony's Python engine. Use it to play against the bot
in a terminal or to run a batch of matches. Browser and terminal games now
call the same JavaScript scorer as the headless worker. The scorer ranks the
engine's legal options using editable weights. The explicit random opponent
is available for comparison.

Run these commands from the NationsBot20 checkout with the sibling
`nations-server` checkout and its virtual environment available.

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/play-nations.py --opponent human --seed 400
& '../nations-server/.venv/Scripts/python.exe' -B scripts/play-nations.py --games 96 --seed 400
& '../nations-server/.venv/Scripts/python.exe' -B scripts/play-nations.py --opponent random --games 96 --seed 400
```

For a single game, add `--replay-out .data/nations-play/my-game.replay` to
save a replay. Batch runs swap the two policies between seats on each pair of
games while reusing the seed. The first live milestone is a private
two-player match with one dedicated bot account.

## First live scoring revision

In round 1 of [match 3270](https://games.tabony.net/nations/3270/), Venice
deployed to Trireme, took Nubia and bought Battle of Thermopylae. It then
took 3 Books from the raid, staffed Glass Blower with four workers, took
Turmoil at 1 Stability and bought Immortal with no Stone left. Replacing
Glass Blower freed all four workers and removed their 8 Books of production.
Resolution applied the revolt penalty before discarding Turmoil.

The revised player keeps the Trireme, Nubia and raid choices in the recorded
positions. At the raid reward it takes 3 Stone, and it values Quarry production
over Glass Blower in the opening position. It prices production and worker
losses before buying a building or military card, uses the placement options
to choose the cheapest slot to replace, and declines Turmoil below 2 Stability.
This last rule is conservative until the picker can evaluate recovery over
several moves.

The regression fixtures come from the live replay. A two-player benchmark
used 32 seeds with both seat orders under the test match's rules. Two seeds
produced a wonder placement with no legal options, so both games for each of
those seeds were excluded. The revised policy won 55 of the 60 remaining games
against the first headless policy, with a mean VP margin of +14.73.

## Shared scorer and training

The scorer lives in `live-player/scorer.mjs`, with 40 named weights in
`live-player/default-weights.json`. Per-player-count profiles override
common weights. The score explanation lists each feature and its weighted
contribution. The local browser and terminal call this implementation through
a persistent Node process. The worker imports it directly.

The local training runner starts from supplied weights, creates Gaussian
mutations, and evaluates each candidate on the same boards with seats rotated.
The best mutation replaces the incumbent when its mean result is higher.
Two-player training maximizes wins. Four-player training maximizes mean
`5/3/2/1` league points. Opponents include fixed starting models and recent
champions. Checkpoints and game-level records are saved for review.

Two initial pilots used three minutes of training each across both player
counts, followed by validation. The first used four boards per candidate and
the second used sixteen. A fresh comparison used another 32 boards per
player count, with every seat rotated. In that comparison the best two-player
profile won 51 of 64 games (79.7%) against the evaluation pool, versus 35 of 64
(54.7%) for initial weights. The best four-player profile averaged 4.05 league
points over 128 attempts, versus 2.98 for initial weights. Each of those
four-player comparisons included one failed game, scored as the worst result.

The pilots exposed an older opponent accepting Korea's free architect when all
five wonder spaces held natural wonders. The engine then offered no legal
placement. Failed games stay in the denominator. The longer run uses the
shared models as opponents. The frozen v0.2 policy remains an evaluation
reference. A duplicated golden-age VP feature was corrected between the pilots,
and both profiles were re-evaluated on the corrected scorer in the fresh
comparison.

### Hour-long experiment and review

After those pilots, training ran for 3,627.59 seconds across two- and
four-player games, using six workers. It evaluated 51,520 simulated matches.
The run resumed from checkpoints twice to fix optional architect completion:
Siberia's extension occupies a protected wonder space, and two events use
different wording for the free-architect prompt. The first two phases retained
53 failed games as worst outcomes; all 27,840 games in the final phase completed.

A fresh comparison used 64 new seeds per player count, with each model rotated
through every seat. Every model faced the same pool of initial weights and the
best short-pilot profiles. These results use 128 attempts per two-player model
and 256 per four-player model. The frozen v0.2 reference had one failed
two-player game, retained as a loss. All other comparison games completed.

| Model | Two-player wins | Four-player league points |
|---|---:|---:|
| Frozen v0.2 | 30.5% | 2.10 |
| Initial shared scorer | 43.0% | 2.32 |
| Best three-minute pilots | 57.0% | 3.25 |
| Twenty-minute checkpoint | 61.7% | 3.37 |
| Full-hour checkpoint | 51.6% | 3.56 |

The longer run added some four-player value: +0.309 league points versus the
short pilot, with an approximate paired-by-seed 95% interval of +0.012 to
+0.605. Its +0.191 advantage over twenty minutes was uncertain (interval
-0.139 to +0.522). Two-player performance peaked at the twenty-minute
checkpoint in this comparison. These are results against the fixed bot pool,
and do not establish playing strength against people.

The local review model combines the twenty-minute two-player profile with the
hour-long four-player profile. It is saved at
`.data/nations-training/final-review/review-weights.json`; the corresponding
`report.md`, `review.json`, `games.jsonl`, and `opening-review.json` record the
comparison, paired estimates, and move explanations. No deployment was made.

The trained two-player profiles pass instead of taking the losing Turmoil or
unneeded Immortal, and protect the staffed Glass Blower in the recorded
positions. They also skip Nubia at decision 15 and choose Food or Books instead
of Stone at decision 20. These choices need position review; skipping Nubia
alone is not a demonstrated regression. In a subsequent review, Kayser accepted
that tradeoff: three opening colonies make access to at least one likely, and
Nubia costs 3 Gold while the other two cost 2. Its lower Military requirement
does not make it the cheapest purchase.

Kayser considers Persia a stronger general draft alternative that preserves
strategic flexibility. A Venice opening with a Trireme deployment also secures
access to cheaper battles and colonies. After that deployment, an opponent can
reasonably prioritize Brewery or the advisor: each is the only available card
of its type and costs 1 Gold. The scorer should compare colony access and
substitutes with the opportunity cost of losing scarce economic cards, rather
than treating the recorded Nubia purchase as an obligatory move. Future work
should improve those comparisons and action-sequence evaluation, broaden the
opponent pool, and periodically validate checkpoints.

## Five-player evaluation

The board-game rules and Tabony's `Match.most_least` agree on the five-player
thresholds. Up to two nations qualify as most. A tie across second and third
excludes those tied nations from most. At least two qualify as least, with
ties extending that set. The first two nations to pass qualify as first, and
the last two qualify as last. The rule also applies to abilities such as Saint
Augustine. Books still award VP for every rival with strictly fewer Books.

Use the same scorer and feature definitions, with a five-player coefficient
profile trained and validated on five-player games. Three- and four-player
games can share a profile provisionally, with separate validation. Five-player
play changes the useful thresholds, card competition, market size and
architect supply, which gives a separate profile a stronger justification.
Until such training, a five-player call uses the four-player coefficients
with the correct five-player rank calculations.

The JavaScript most/least helper matched the Python engine on 500 randomized
cases spanning two through six players. Local three- and five-player smoke
games also completed all eight rounds. The five-player coefficient profile has
not yet been trained.

## Card urgency

For a desirable progress card, ask whether another player can buy it or change
its availability before our intended purchase. This is a separate question from
how valuable the card is if we get it.

- Start with rivals still taking actions and their position in turn order. Look
  at the effective cost and eligibility for each rival, including discounts and
  military requirements. Distinguish what is legal now from what becomes
  reachable after a setup action. Check remaining Turmoil, gold sources such as
  Marco Polo, and market actions such as Alhazen when the rival has time to use
  them. A rival who can afford a card is a potential competitor, and a rollout
  can estimate whether they are likely to take it.
- Buying a contested card generally takes priority over a deployment we can make
  later on our own board. Give military deployment urgency when it unlocks a
  contested colony or makes it possible to start a war in time. Also look for
  effects such as Suleiman I, whose action requires most military.
- Compare the order of two moves when they consume different resources or
  change future options. Treat both orders as equivalent for evaluation when the
  relevant replies and outcomes are equivalent. Human imitation can learn a
  preference between those orders even though neither improves the result.

### Delaying a safe purchase in round 7

[Match 400](https://games.tabony.net/nations/400/), round 7, immediately before
recorded move 749. China and Ethiopia had passed. Mongolia had no Gold, the
Turmoil supply was empty, and Mongolia's available Great Barrier Reef action
gives Food. Greece deployed to **Cavalry** at move 749 and bought **Urban Center**
at move 753. The bought card was safe to leave on the market for the intervening
turn. Longships was another legal deployment, considered in the earlier analysis.

In a local replay check, Greece instead bought Urban Center first and deployed
to Cavalry on its next turn. With Mongolia's recorded response, the engine
reconstructed the same visible state after both actions and the same final state.
Use this position to test whether the picker recognizes the lack of market
urgency. A companion test should give a rival a credible way to take or move
Urban Center in the intervening turn.

### The opening colony race

The opening market in match 400 showed Armenia (6 Military, 2 Gold) and Hindu
Kush (9 Military, 3 Gold), alongside two 1-Gold battles. LindenR picked
Mongolia first in the draft and played last in round 1. Two Horse Archer
deployments cost 4 Stone, used two actions, and gave 10 Military with 2 Food
upkeep. That opened both colonies. Hindu Kush produced 3 Stone per round, and a
deployed Horse Archer gave 4 raid resources from a battle.

Tankare picked Ethiopia while Greece was available. With Greece's two Hoplite
deployments he could have reached Armenia's threshold and had the first purchase
opportunity ahead of Mongolia on that line. Ethiopia's Axumite Kingdom dynasty
was another consideration in Kayser's assessment. The replay shows the pick
and that Tankare played the dynasty in round 1. His reason for picking Ethiopia
is unknown.

Kayser picked Greece and also spent two actions deploying, reaching 6 Military
before Mongolia completed its second deployment. On Greece's third action
(move 38), both could afford Armenia and both met its Military requirement.
Greece acted first and bought it. In a replay branch, Greece took Battle of
Issus at move 38 instead. After Ethiopia's recorded reply, Mongolia legally
bought Armenia on its next turn.

Mongolia was the only nation eligible for Hindu Kush on its third action.
LindenR took Siege of Alesia for 4 Stone, bought and staffed City Wall, and took
Turmoil for Gold before buying Hindu Kush at move 87. While Greece and Mongolia
spent their first two actions deploying, China took Forum and Colosseum, and
Ethiopia took Mine and Praetorian Guard. China then added Hatshepsut, who grants
3 Books when a wonder is completed.

For each draft candidate, evaluate the opening sequence from the available
starting board, growth choices, and first-round turn order. Keep the earliest
legal purchase turn and the resources and actions needed to reach it. Check
whether the same setup opens a second colony or a cheap raid. Compare the
sequence with opening purchases that would be delayed or lost. During play,
recompute the race after each relevant action. Test that the picker sees the
immediate threat to Armenia and the time Mongolia had to take other cards
before Hindu Kush.

### A draft where neither nation secures Armenia

In a variant of match 400, replace China in the remaining draft pool with a
second nation that can reach Armenia's requirement in two deployments of
3 Military each. Assume both nations can pay for those deployments and the
colony. After Kayser picks either nation, the player who acts before him can
draft the other and buy Armenia first on the same opening. This removes the
value of a secured Armenia from both draft choices. The opponent may pursue
something else, so Armenia can still become available opportunistically.

For each pick, inspect who drafts from the remaining pool and where they act
in round 1. Compare the earliest purchase turns and resolve ties with actual
turn order. If an earlier seat can match the opening, compare plans that spend
those turns on other cards, such as buildings and wonders. Consider the
starting board and dynasties even when a nation has no clear route to a
contested card. Reassess the colony if the earlier player chooses a different
opening.

## Historical nation results

Use historical results as a baseline for each available nation. Update the
draft evaluation with turn order, the remaining draft pool, and the opening
market. A nation can be a good general pick without having a strong opening on
this board.

The Tabony export `completed_matches_2730.tar.gz` contained 2,730 replays, all
of which reconstructed through game over. The table covers the 486 four-player
matches that went through round-eight scoring. The other replays had different
player counts, including 67 two-player games that ended early. Use the final
order under each replay's rules and convert it to league points using
`5/3/2/1`. The league-points column is an average per appearance.

| Nation | Games | First | Second | Third | Fourth | Win rate | League points |
|---|---:|---:|---:|---:|---:|---:|---:|
| China | 126 | 56 | 34 | 20 | 16 | 44.4% | 3.48 |
| Greece | 136 | 47 | 28 | 28 | 33 | 34.6% | 3.00 |
| Persia | 137 | 46 | 44 | 25 | 22 | 33.6% | 3.17 |
| Japan | 141 | 43 | 33 | 41 | 24 | 30.5% | 2.98 |
| Egypt | 90 | 27 | 32 | 15 | 16 | 30.0% | 3.08 |
| Rome | 141 | 39 | 39 | 33 | 30 | 27.7% | 2.89 |
| India | 148 | 39 | 41 | 31 | 37 | 26.4% | 2.82 |
| Ethiopia | 136 | 34 | 31 | 35 | 36 | 25.0% | 2.71 |
| Korea | 125 | 31 | 34 | 36 | 24 | 24.8% | 2.82 |
| America | 82 | 18 | 17 | 30 | 17 | 22.0% | 2.66 |
| Venice | 113 | 20 | 32 | 27 | 34 | 17.7% | 2.51 |
| Mongolia | 122 | 21 | 28 | 41 | 32 | 17.2% | 2.48 |
| Vikings | 100 | 17 | 22 | 26 | 35 | 17.0% | 2.38 |
| Portugal | 98 | 16 | 21 | 30 | 31 | 16.3% | 2.39 |
| Mali | 60 | 9 | 13 | 19 | 19 | 15.0% | 2.35 |
| Arabs | 96 | 12 | 26 | 24 | 34 | 12.5% | 2.29 |
| Poland | 93 | 11 | 11 | 25 | 46 | 11.8% | 1.98 |

These are observed results after players drafted their nations. The rates mix
player skill, draft and turn positions, visible markets, and rules variants.
Kayser's assessment of Korea and Ethiopia as strong general picks gives us a
reason to check those factors before treating the middle of the table as a
strength ranking. Training should estimate any historical baseline from the
training matches only.

## Round assessment

| Consideration | What the picker should measure |
|---|---|
| Events | Read the active events first. Compute who currently qualifies for bonuses or penalties, what moves change that, and how close rivals are to the relevant thresholds. Track resources, turn order, and VP separately so the model can learn when economy or initiative outweighs immediate VP. |
| Colonies | Especially early, estimate who can reach each visible colony first and whether we can take more than one. During the draft, include the available nations, their starting boards, the first-round turn order, and the revealed market. During play, include the cost and time to reach the required military and to buy the card. |
| War | Distinguish a war already in play from wars still on the progress board. Estimate who can start a war, at what strength, and the losses to each nation. Reduce the value of extra military when there is neither a credible war nor a contested colony, while still accounting for turn order, events, and card effects. |
| Wonders | Track available wonders, shared and private architects, rival projects, and how many hires and how much Stone each project still needs. Buying the only available wonder can secure shared architects when rivals lack projects. If others can hire, estimate how early we must act to finish ours. |
| Buildings | Look for upgrades to buildings from earlier ages and project balanced production after purchase, deployment, and replacement. Use next-round reserves of `4 + Age` Gold and `2 + 3 × Age` Stone as starting heuristics. Track distance from these targets as features. |
| Food | Project Food through upkeep, production, war, events, and famine using Tabony's timing. Include plausible extra losses, such as the Vikings' choice after production. Avoiding a current deficit comes first. A reserve around the expected next-round famine helps absorb pressure. |
| Books | Use the gaps to individual rivals and projected changes up to the next scoring round. In even rounds the payoff is immediate. Each age awards one VP per rival with strictly fewer Books. Across the four ages that means up to 4 VP for one player in a two-player game, and up to 16 for one player or 40 across the table in a five-player game. |

These are checks to make when assessing a round. Their priority can change within
the round as cards disappear, rivals pass, and thresholds become reachable.

## Outcomes and player count

For four-player SM play, record the full finishing order in training and
simulation. Score a candidate by its expected league points, using `5/3/2/1`
for first through fourth. Use the match's actual scoring and tiebreakers when
labeling finishes. Measure league points per game on matched games with seats
rotated, alongside the distribution of finishes.

Treat two-player games as a separate evaluation setting. The competitive outcome
is head-to-head, and losing resources can be favorable when the opponent's larger
loss improves our relative position. Compute both sides' effects and measure
head-to-head win rate. Compare models on four-player matches before allowing
two-player replays to influence the league picker.
