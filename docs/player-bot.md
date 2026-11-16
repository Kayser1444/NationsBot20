# Player Bot administration

The existing owner console has a `/player` sub-page, reached from the Player Bot
link on its home page. It reuses Discord owner sign-in, HTTPS, the owner session
and CSRF checks. Game access is a separate list of exact Tabony account names,
initially `Kayser`. Every human participant must be on that list.

Controls include automatic discovery on/off, a poll interval from 15 seconds to
one day, manual **Poll now**, automatic invitation acceptance, a separate pause
for playing, allowed player counts, a concurrent-game limit, move delay, and
growth for invitations with variable difficulty. Pausing discovery does not
pause connected games. Pausing playing prevents new moves and invitation joins.
An already submitted move remains submitted.

Two-player and multiplayer checkpoint selectors are independent. Both default
to **Human baseline v2 — dynasties**, the replay-trained policy with shared tactical checks.
The twenty-minute, full-hour and initial heuristic checkpoints remain available.
On first upgrade, existing installations select the baseline once;
authorization, polling, play/pause and other settings are preserved. Later model
selections persist normally. v0.6 upgrades an existing v1 selection to v2 while
preserving manually selected heuristic checkpoints. See the
[dynasty training evidence and benchmark](dynasty-policy.md).
Advanced JSON overrides can edit named coefficients in profiles `2` and `4`;
three and five players use profile `4`. Effective weights are visible below the
selectors. These overrides apply to the older heuristic checkpoints; the human
baseline uses its bundled learned coefficients. Settings survive restarts in
the player volume's `/data/player-settings.json`.

**Experimental RL** is available in the two-player selector when the player has
a compatible checkpoint. Choose a specific version for newly connected matches.
Each running match has its own **Model** selector in the **Games** table. Choose
a checkpoint there to change that match immediately. The next move the bot sends
uses the new model, and the match keeps its selection across reconnects and
restarts. A move already sent still waits for confirmation. The advanced
coefficient overrides do not change the neural model.

The page shows the worker version, account socket, last/next discovery time,
game participants, current turn, pending move confirmation, selected model and
recent activity. A stale form revision is rejected instead of overwriting a
newer save. Removing an authorized player closes their game connections.
Lowering the concurrency limit affects new connections. Games whose journal or
server response is ambiguous stop and retain their receipt for inspection.

## Service connection

The admin service proxies fixed operations to the player over Railway's private
network. It does not receive the Tabony password or session cookie. Configure
the following in the same Railway environment:

| Service | Variable | Value |
|---|---|---|
| Admin | `NATIONS_PLAYER_CONTROL_URL` | `http://nationsbot20-player.railway.internal:8080` |
| Both | `NATIONS_PLAYER_CONTROL_TOKEN` | The same randomly generated 32-byte hex credential |
| Player | `NATIONS_PLAYER_CONTROL_PORT` | `8080` (default) |

Keep that credential in hosting variables and out of source and browser code.
The player control service has no public domain. Its status and mutation routes
require the credential. The admin forwards the authenticated Discord owner ID
as the actor when saving settings or changing a match model. The existing `TABONY_PASSWORD` remains sealed
on the player service.

Setting the control credential starts the managed player runtime. Without it,
the previous fixed-match mode remains available. Managed mode discovers the
signed-in account's current matches and invitations, verifies the account and
all participants, and opens one worker per eligible full game. It supports two
through five players. Open lobbies are revisited on later polls. All move
submissions retain the persistent journal and offered-option checks.

An account WebSocket requests discovery after notifications; a timer covers
new invitations that do not emit a notification. Notifications are coalesced
and briefly throttled; manual and scheduled polls share one in-flight operation.
Account WebSockets reconnect after disconnection, and expired listing sessions
are logged in again. Background errors are shown on the page and retried at the
next scheduled poll.

Training scripts continue to use `default-weights.json` as their fixed baseline.
The managed player loads older checkpoints from `live-player/models.json` and
the baseline from `live-player/human-baseline.json`. See
[training and release evaluation](human-policy.md).
The standalone worker still supports `NATIONS_PLAYER_WEIGHTS`.

## Install another experimental checkpoint

Export a verified training checkpoint on the training PC with
`experiments/nations-rl/export.py`. Pass the training run's frozen card index,
and use `check_export.py` to check the export against the Node player. The
exporter names the `.nrl` file by its content hash. Upload it to the root of
the intended player's Railway volume without overwriting any earlier file.
The player checks the hash, format, tensor dimensions and card catalog before
listing it. Refresh the Player Bot form to see the new choice. Compatible
exports need no service deploy. Keep versions referenced by existing games.

On staging, the player service has a private volume mounted at `/data`.
The first checkpoint uses 10,000 training games and the selector label
**Experimental RL · 10,000 games · c64187ec**.

Run `npm test` and `node --test --test-isolation=none live-player/*.test.mjs`
before release. The latter includes persistence, profile selection, discovery,
invitation confirmation, access revocation, coalescing and private API checks.
