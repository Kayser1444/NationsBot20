# Policy learned from Tabony replays

The pilot learns which legal move a player selected from a public position.
It covers nation drafts, growth and ordinary action prompts in two- and
four-player games. The baseline uses Easy for unsupported prompts. Three- and
five-player decisions use the shared learned features; coefficients specific to
those player counts were not trained. Local and hosted play share `live-player/baseline.mjs`,
which compares card placements using the public position.
That check values current production and workers as well as the options that
an undeployed card gives you, such as opening a war with Horse Archer.

The shared move ranking also checks the visible architect supply before buying
wonders, projects a risky Turmoil benefit, and compares a same-turn worker
transfer when Gold is scarce. The transfer accounts for the deployment cost
and preserves Military without creating or worsening a revolt. Advisor purchases
are compared after projected placement, allowing production, Alhazen's swap, Old
Kingdom's demand for advisors and newly affordable colonies to affect the ranking.
Use **Explain position** to see these adjustments in a local replay.

The hosted worker cannot reconstruct a live replay's hidden seed. Its tactical
checks use public snapshots and ordinary printed effects; bespoke effects are
incomplete. The older Python engine-backed helpers remain available for local
placement explanations, but do not choose baseline moves. The browser bot,
benchmark runner and Railway worker now choose with the same JavaScript code.

The v0.5 release evaluation used fresh seed 61371000, both seats on 32 boards
per two-player opponent, and all four seats on 24 multiplayer boards. It won
60/64 against Easy (93.75%), 60/64 against v0.2 (93.75%), and 82/96 against
three Easy bots (85.42%). All 224 games completed. Four-player placements were
82 first, 11 second and 3 third; mean league points 4.677 on the 5/3/2/1 scale.
Paired-board bootstrap 95% win-rate intervals were 85.94–100% for both
two-player groups and 78.13–92.71% for four players.

An earlier compatibility run on the previous seed set scored 58/64, 60/64,
and 37/48 respectively, with one v0.2 opponent failure counted as a non-win.
The release also corrected projected Books lost to negative Stability before
the fresh-board evaluation. These results are against simple bots, not evidence
of a comparable win rate against people. Three- and five-player performance
has not been benchmarked. Five-player most/least handling remains in the
shared scorer; a five-player learned policy still needs training and evaluation.

`live-player/baseline-info.json` records the release results, rules and scorer/model
SHA256 hashes. Full reports and replays remain in `.data/human-policy/release-final/`.

On the [human-policy test board](http://127.0.0.1:8767/), select **Human replay policy**
from the **Bot** menu. The server loads `.data/human-policy/v1/policy.json`
when it starts. Use `--human-policy PATH` to try another trained checkpoint,
or use the following command to keep a separate local game for this model.

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/serve-nations.py --port 8767 --difficulty human --save .data/nations-play/human-policy-v1.replay
```

The extractor reconstructs each replay with the Tabony engine and records the
position before the move. It keeps games that reached round-eight scoring and
filters replays containing explicit undo commands or a known NationsBot account.
Names are replaced with seat identifiers. The record includes final rank for
analysis and later value training. The model receives the position and legal
options as inputs, and the recorded move supplies the training label.

Train, validation and test splits group by the replay's starting seed, keeping
an entire game and any games sharing its seed on the same side of the split.
The model uses a linear softmax over features of each legal move, including
card identity, phase, resources, available workers and competition for visible
cards. The hand-written scorer contributes some input features. Training learns
their coefficients from human choices. Validation selects the checkpoint by
move prediction log loss. Test results report top-one and top-three agreement
against Easy, with separate results by player count and decision type.

From the NationsBot20 checkout, point the extractor at your Tabony archive and
choose an unused output directory.

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/extract-human-nations.py "$env:USERPROFILE/Downloads/completed_matches_2730.tar.gz" .data/human-policy/v1
node scripts/train-human-nations.mjs .data/human-policy/v1 1
& '../nations-server/.venv/Scripts/python.exe' -B scripts/evaluate-human-nations.py .data/human-policy/v1/policy.json --output .data/human-policy/v1/self-play.json
```

The second evaluation rotates the learned policy through every seat against
Easy under the training rules, alongside an Easy-only control on the same
boards. Two-player outcomes use wins. Four-player outcomes use the full order
and the 5/3/2/1 league scale. The report includes incomplete games and the
number of board sets that completed in both arms.

To evaluate the full local bot, including placement and tactical checks, run
the browser policy against Easy and the original v0.2 heuristic. The runner
swaps seats on each two-player board and rotates through every seat against
three Easy opponents in four-player games. It saves the game records and
counts incomplete games in the attempted-game win rate.

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/evaluate-local-nations.py .data/human-policy/v1/policy.json --output .data/human-policy/current-benchmark
```
