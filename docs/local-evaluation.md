# Native local Nations evaluation

Start from the NationsBot20 checkout, with the sibling `nations-server` checkout
and its Python virtual environment installed:

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/serve-nations.py
```

Open [the local board](http://127.0.0.1:8765/). This uses Tabony's actual canvas
renderer and native board, cards, nation boards, workers and resource markers.
Card interactions, confirmation, replay navigation and scale controls use the
native client. The transport talks only to the local engine. The earlier board
view remains at `/legacy`.

The local server requires Django's template engine as well as the Nations engine
and Node.js 24 for the shared scorer; the existing sibling virtual environment
contains these dependencies. It does not start Django's live game server or
connect a Tabony account.

## Play and review

- **Bot** switches between Easy and Medium for the next bot turn in the current
  game. The setting is saved with the game.
- **New game** starts a new local match at the selected difficulty. The previous local replay
  is archived automatically.
- **Review match 3272** loads the captured opening positions from the current
  human evaluation. Use the timeline or Previous/Next to inspect the draft,
  growth and military/Forge decisions. These public snapshots have no replay
  seed, so they are read-only and cannot be used to branch a full game.
- **Open replay** accepts a complete `.replay` or text replay, up to 2 MB,
  including two- through five-player games. Original rules and player names are
  reconstructed from its header. Reviewing a replay does not overwrite the
  active local game.
- **Play from here** creates a local branch from a full replay. Select the human
  seat with **Play as**. The other players use the selected difficulty. The previous local game is
  archived before the branch is saved.
- **Resume local game** leaves review mode and returns to the active local game.
- **Save replay** exports the complete active/imported replay. Snapshot review
  instead offers **Save position**.
- **Explain position** compares Easy's rankings with Medium's predicted moves,
  replies and depth. It also displays the basic colony routes, rival deadlines
  and Food forecasts. The two scores use different scales.

The active game is saved in `.data/nations-play/browser.replay`. The selected
human seat is saved alongside it in `browser.meta.json`. Archived local games
are in the same directory's `archives` subdirectory. Use `--save PATH` for a
separate session and `--seed NUMBER` for a reproducible new opening. Reusing an
existing save resumes it, irrespective of the supplied seed.

Easy defaults to `live-player/trained-weights.json`: the twenty-minute
two-player profile and full-hour four-player profile for three through five
players. Pass `--weights PATH` to compare another model. The displayed decision
time is measured work, including the local scorer bridge, without artificial
delay.

## Native assets and offline use

Images are cached in `.data/nations-native-assets` on first use. Prefetch the
renderer artwork before disconnecting from the internet:

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/cache-native-assets.py
```

The initial cache contains 530 assets, approximately 15.7 MB, including the
pinned Bootstrap stylesheet. The cache manifest records any unavailable files.
After caching, local game actions and replay review need no live Tabony service.
The native renderer's MIT licence and provenance are retained in
`scripts/nations-browser/native/`. Artwork remains in the ignored local cache.

## Difficulty roadmap

| Mode | Decision method | Intended budget | Current state |
|---|---|---|---|
| Easy | Shared weighted scorer | Immediate; typically milliseconds | Playable |
| Medium | Up to three levels of common actions and opponent replies on the visible board | 2-second search budget per decision | Playable prototype |
| Hard | Medium's candidate plans plus OpenAI reasoning, checked against legal options and simulated outcomes | Roughly 20–30 seconds | Planned; no API calls wired into local play |

Medium completes each comparison at a common depth and keeps the last complete
comparison if the budget runs out. It models common actions and Old Uppsala,
estimates private deployment and leaves hidden draws, most special effects and
round resolution outside the search. The local engine checks the chosen move
and any planned placement or reward against its legal options. Unsupported
subdecisions use Easy when a planned option is unavailable.

Run `node scripts/compare-nations.mjs` to compare both policies on match 3272.
These positions test opening decisions. Strength over a full game requires
games on held-out boards with seats swapped, using head-to-head wins in two
players and league points in four players.

See [the human replay policy](human-policy.md) for the separate move prediction
and self-play experiments using Tabony's archive.

## Checks

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/test-native-nations.py
node --test --test-isolation=none live-player/*.test.mjs
```

The local integration tests use the real engine and verify native template
rendering, legal move submission, origin/revision checks, snapshot immutability,
position explanations, replay import/navigation, branching, archive preservation
and rejection of malformed replays and unsafe asset paths. They do not contact
Tabony or Discord.
