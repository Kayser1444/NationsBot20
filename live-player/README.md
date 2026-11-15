# Nations headless player

The managed player discovers authorized Tabony invitations and games and plays
two- through five-player matches through WebSockets. The existing owner console
has a Player Bot sub-page for access, polling, model and game controls; see
[Player Bot administration](../docs/player-bot.md). Without the private control
credential, the standalone worker plays its one configured two-player match.
Tests use fake login responses, WebSocket messages and recorded positions.

The shared scorer in `scorer.mjs` evaluates every visible opponent and uses
`default-weights.json` for its 40 named coefficients. Local browser games,
terminal games and training call the same code through a persistent Node
process. The WebSocket worker calls it directly. The model estimates resource,
production, threshold and timing effects. Tabony's engine resolves the rules.

Models contain a common `weights` object and `profiles` overrides for `2`
and `4` players. Three-player and five-player evaluation currently use the
four-player coefficients. An explicit `5` profile can override them later.
The shared most/least calculations already use the five-player threshold and
tie rules, as do first-to-pass features.

Set `NATIONS_PLAYER_WEIGHTS` to a model file's absolute path when starting a
local game or the worker to select a candidate model. Training checkpoints are
kept separately from the default model. The Docker image sets this variable to
`/app/trained-weights.json`: the approved twenty-minute two-player checkpoint
for two players, and the full-hour four-player checkpoint for three, four and
five players. Three- and five-player profiles reuse the four-player weights
and have not been trained separately. The model file records checkpoint hashes,
and startup logs identify the model and its SHA256.

## Railway staging

The dedicated service is **NationsBot20-Player** in the **staging** environment
of the NationsBot project. It has one instance, a private `/data` volume, and
no public endpoint. The deployment source is this directory.

| Variable | Test match value |
|---|---|
| `TABONY_MATCH_ID` | `3270` |
| `TABONY_USERNAME` | `NationsBot20` |
| `TABONY_OPPONENT` | `Kayser` |
| `TABONY_PLAY` | `1` to play, `0` to observe |
| `TABONY_PASSWORD` | Enter the bot's password as a sealed service variable |
| `NATIONS_PLAYER_DATA_DIR` | `/data` |

Without a password the service observes the match. With play enabled and a
password set, it verifies the signed-in account and checks the two participants
before sending moves. If a connection breaks during a submission, it waits for
the server's move number to advance before sending another move. A persistent
receipt prevents retrying an ambiguous move after a restart.

To pause play, set `TABONY_PLAY=0` in the worker's Railway Variables tab and
deploy that change. The worker stops on game over.

The managed-player release is v0.4.0. The bundled default weights were approved
on 2026-11-15. The admin page can choose the initial scorer, twenty-minute or
full-hour checkpoint independently for two-player and multiplayer games.

Previous fixed-match Railway staging deployment: `4da534b6-5279-4279-8e44-e10cef284560`.
Runtime logs confirmed v0.3.0, the bundled model SHA256
`87a3a721930f60094c1d01d398d45cf66b9a0d527e0a662537f5bfe78ce21148`,
and authenticated subscription to match 3270. The deployment receipt and source
hashes are in `.data/nations-player-deployments/2026-11-15-v030.json`.

## Maintenance

Run `node scripts/export-player-cards.mjs` from the repository root to refresh
the compact card index from the card library. Run the worker tests with
`node --test live-player/*.test.mjs`.

## Short training pilot

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/train-nations.py --seconds 180 --population 5 --boards 4 --validation-boards 64 --workers 6 --output .data/nations-training/my-pilot
```

The time budget covers evolutionary training across the selected player counts.
Validation runs after that budget and takes additional time. Each generation
tests the incumbent and four Gaussian mutations on common seeds with each
candidate rotated through every seat. The best candidate becomes the new
incumbent. The opponent pool uses the initial model, the starting model and
recent champions. Supply `--legacy-opponent` to include the frozen v0.2 policy
in that pool. Training seeds change each generation. Held-out validation seeds
are reserved for the final comparison with initial weights and v0.2.

The two-player objective is wins. The four-player objective is mean `5/3/2/1`
league points. Failed games count as zero reward and are reported explicitly.
They are never removed from a candidate's denominator. The output includes
candidate models, every game's outcome, generation scores, source hashes and
validation summaries.

Use `--initial-model path/to/model.json` to start another run from selected
coefficients. Every generation saves a checkpoint as well as the latest
candidate. Validation compares the final candidate with the starting model,
initial weights and the frozen v0.2 policy.

For an explanation, call `explainMoves(state, username, model)` from
`policy.mjs`. Each row has a score, the raw feature values, and their weighted
contributions. The contribution values sum to the score.

```powershell
node scripts/explain-nations.mjs --state live-player/fixtures/match-3270-opening.json --decision 52 --player NationsBot20
& '../nations-server/.venv/Scripts/python.exe' -B scripts/serve-nations.py --weights .data/nations-training/my-pilot/candidate-2p.json
```

The browser reads the selected model when its server starts. Restart that local
server after editing the model. A trained candidate stores its coefficients in
`profiles.2` or `profiles.4`, overriding the common `weights` entries.

| Coefficients | Interpretation |
|---|---|
| `food`, `gold`, `stone`, `books` | Resource gains and losses, adjusted for current scarcity and Books gaps to each rival |
| `victoryPoints`, `goldenAge` | VP gained and golden-age purchases |
| `futureProduction`, `shortage`, `reserve` | Remaining production rounds, Food deficit prevention and the cost of growing more workers while some are idle |
| `colonyThreshold`, `colonyProgress`, `colony` | Reaching colony requirements, making progress toward them and buying a colony |
| `warThreshold`, `warLoss`, `turnOrder`, `idleMilitary` | Crossing war strength, exposing rivals to defeat, improving military order and residual military strength |
| `stability`, `revolt` | Stability changes and crossing below or back above zero |
| `replacementOutput`, `strandedWorkers`, `redeploymentCost` | Lost production, workers without redeployment funds, and Stone expenditure |
| `purchaseCost`, `urgency`, `building`, `military`, `advisor` | Purchase costs, competition for a card and card-type estimates |
| `wonder`, `wonderCompletion`, `architectUrgency` | Wonder acquisition, progress to completion and competition for architects |
| `workerGrowth`, `workerUse`, `turmoil`, `special`, `dynasty` | Growth, deployment and action-specific estimates |
| `pass`, `earlyPass`, `eventBonus`, `eventThreat` | Passing and changes in eligibility for events |
| `draftEconomy`, `draftMilitary` | Starting resources, building output and military openings visible during the draft |

Feature extraction uses estimates for complex special effects, future card
competition and building payback. It does not simulate alternative action
sequences. Draft evaluation currently uses the starting economy and military
potential rather than solving the full colony race.

Compare saved pilots on a new seed range with:

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/evaluate-nations.py --runs .data/nations-training/pilot-01 .data/nations-training/pilot-02 --boards 32 --output .data/nations-training/review
```

Use `--opponent-model path/to/model.json` for a fixed opponent pool containing
that model and the initial weights. Reuse this pool and a fresh seed range when
comparing longer training with a short pilot. This separates improvements in
the candidate from changes in the opponents used during training.
