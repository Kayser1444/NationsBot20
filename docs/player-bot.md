# Player Bot administration

The existing owner console has a `/player` sub-page, reached from the Player Bot
link on its home page. It reuses Discord owner sign-in, HTTPS, the owner session
and CSRF checks. Game access is a separate list of exact Tabony account names,
initially `Kayser`. A regular bot can play when at least one other participant
is on the list. Other seats can be held by unlisted players or other bots.
When playing is enabled, regular bots keep invitations pending if no
participant is eligible, the player count is disabled, or the bot is at
capacity. A second 1v1 invitation from the same opponent also waits until
their current game ends, even if the bot can play more games. The bot explains
the reason in match chat and rechecks on later polls. It accepts once eligible
if automatic acceptance is enabled.

Invitation notices use the inviting player's Discord bot language when the
Tabony name is associated with one Discord account. This follows `/language`
and its automatic Discord locale detection. The bot uses English if it
cannot resolve a unique player or account.

The service-wide **Play mode** is **Closed**, **Invite only**, or **Open**.
Closed stops Tabony discovery, game connections and new Discord challenges.
Invite only applies the authorized-player list to Tabony games and Discord challenges.
Open accepts eligible Tabony players without an allowlist. Tournament takeover
accounts still use their approved match IDs in both active modes. Existing settings
without a mode default to Invite only.

Controls include automatic discovery on/off, a poll interval from 15 seconds to
one day, manual **Poll now**, automatic invitation acceptance, a separate pause
for playing, allowed player counts, a concurrent-game limit, move delay, and
growth for invitations with variable difficulty. Pausing discovery does not
pause connected games. Pausing playing prevents new moves and invitation joins.
An already submitted move remains submitted.

## Questions in Tabony chat

While the bot is playing, a participant can ask it a question in the match
chat. In a two-player game, type a question ending in `?`. In a multiplayer
game, start it with the bot's username, for example `@NationsBot20, Who has
the most Military?` Spectators' messages and old chat history never trigger replies.

The bot sends a one-line reply in Tabony using the same model and rules sources
as Discord's `/question`. For questions about the match, it can use the visible
board at the time of the question and the recent public game log. It can explain
what the position suggests and say when the available information is insufficient.
Questions and that public context are sent to OpenAI. Ask your next question
after the bot replies. Each Tabony account can ask up to five questions per
day, and both channels share the daily service budget.

To enable this on Railway, set `NATIONS_TABONY_QUESTION_ENABLED=1` and
`NATIONS_TABONY_QUESTION_PORT=8082` on the notifier with `/question` enabled.
Set `NATIONS_TABONY_QUESTION_URL` on the player service to the notifier's private
origin, for example `http://nationsbot20-staging.railway.internal:8082`. The two
services already share `NATIONS_PLAYER_CONTROL_TOKEN`; keep port 8082 private.

## Models

The two-player and shared multiplayer checkpoint selectors default to
**Human baseline v2 — dynasties**, the replay-trained policy with shared
tactical checks. The **Four-player checkpoint** selector can override the
shared checkpoint for new four-player seats. Three- and five-player games
use the shared multiplayer checkpoint.
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

**Experimental RL** is available when the player has a compatible checkpoint.
Experimental checkpoints appear in the selector for their supported player
count, in compatible seat selectors and in the account default selector.
In multi-account mode, each account has a **Default model for new games**.
**Use service default** follows the selectors under AI model. An
experimental account default applies to its supported player count. Other
matches use the applicable service default. A seat saves its model when it
first connects. The **Games** table
shows a row for each controlled seat and lets you choose its model before or
during play after discovery. A change applies to the next move the seat sends.
Seat selections survive reconnects and restarts. A move already sent still
waits for confirmation. The advanced coefficient overrides apply to heuristic
checkpoints.

Finished games stay in **Games** for 48 hours after the player service records
their completion. They then move to **Archive**, which starts collapsed.
Recorded games stay available across service restarts.

The page shows the worker version, account socket, last/next discovery time,
game participants, current turn, pending move confirmation, selected model and
recent activity. A stale form revision is rejected instead of overwriting a
newer save. Removing the last eligible player from a game's access list closes
the bot's connection.
The concurrency limit applies per account and affects new connections. Games whose journal or
server response is ambiguous stop and retain their receipt for inspection.

## One human and three bots

1. Register `NationsBot20`, `NationsBot20_2` and `NationsBot_3` under **Tabony
   accounts** using their existing Tabony credentials. New accounts start stopped.
   Select each account's default model, or keep the service default.
2. Add the human's exact username under **Authorized Tabony players** and allow
   four-player games. In Tabony, create a four-player match and invite the three
   bot usernames.
3. Use **Poll now** to discover the invitations and set any seat-specific models
   in **Games**. Use **Start play** on all three accounts. Enable service-wide
   playing and automatic invitation acceptance, or accept each invitation in
   Tabony. Keep automatic discovery enabled so the bots connect after the
   lobby starts. With discovery paused, use **Poll now** again once all
   invitations are accepted.

**Stop play** disconnects the selected account's game workers. The account can
still discover matches and check its login. **Delete** also removes the stored
credentials. Existing per-seat model selections and move receipts are retained
so re-adding an account can safely resume a match.

## Finish a tournament player's games

Confirm the organizer's approved match IDs and obtain authorized access to the
Tabony account that holds the seats. Add that account with **Tournament takeover**
scope and enter those IDs. Review the discovered seats, choose the models and
start the account. Discovery checks both current and archived matches, since
Tabony archives games after seven days without a turn update. Only the listed
ongoing games in which that account holds a seat are eligible. The match-ID
approval covers the other players in those games. Stop play when the player
returns, or delete the account after the handoff or after the games finish.

A workflow for formally reassigning a seat to a different Tabony account would
need support from Tabony and the tournament organizer. Creating and inviting
players to a game from the owner console would also be a separate integration.

## Service connection

The admin service proxies fixed operations to the player over Railway's private
network. It does not receive the Tabony password or session cookie. Configure
the following in the same Railway environment:

| Service | Variable | Value |
|---|---|---|
| Admin | `NATIONS_PLAYER_CONTROL_URL` | `http://nationsbot20-player.railway.internal:8080` |
| Both | `NATIONS_PLAYER_CONTROL_TOKEN` | The same randomly generated 32-byte hex credential |
| Player | `NATIONS_PLAYER_CONTROL_PORT` | `8080` (default) |
| Player | `NATIONS_PLAYER_CREDENTIAL_ENCRYPTION_KEY` | A separate, random 32-byte hex key, sealed in Railway |
| Player | `NATIONS_PLAYER_CHALLENGE_ACCOUNT` | Exact Tabony username of the regular bot account that handles open-beta challenges |

Keep that credential in hosting variables and out of source and browser code.
The player control service has no public domain. Its status and mutation routes
require the control credential. The admin forwards the authenticated Discord
owner ID with mutations. When adding an account, the owner console forwards its
credentials to the player over the private network. Status responses omit
passwords and session cookies.

The account key enables multi-account mode. Generate a separate key per
environment, seal it in the player service as described in the
[Railway variables documentation](https://docs.railway.com/variables#sealed-variables)
and retain a secure backup of the key with access separate from the volume
backup. The player stores authenticated AES-256-GCM encrypted names and
passwords in `/data/player-accounts.sqlite`. The service needs the original
key to reopen the vault.

If the managed worker already uses `TABONY_USERNAME` and `TABONY_PASSWORD`,
the first startup with the vault imports that account with its prior
`TABONY_PLAY` setting and reuses its saved match models and journals. After
confirming the imported account in the owner console, remove legacy Tabony
variables from that managed worker. In multi-account mode, the global
**Pause playing** control and each account's start/stop setting govern moves.

Setting the control credential starts the managed player runtime. Without it,
the previous fixed-match mode remains available. Managed mode discovers the
signed-in accounts' matches and invitations, verifies each account and all
participants, and opens one worker per controlled seat in an eligible full game. It supports two
through five players. Open lobbies are revisited on later polls. All move
submissions retain the persistent journal and offered-option checks.

When Tabony confirms that the last invitation accepted by a bot filled the
lobby, automatic discovery refreshes the participating bot accounts. One
WebSocket per signed-in account triggers discovery for invitation and turn updates.
Updates received during a refresh or within five seconds of its completion queue
one follow-up refresh. A periodic fallback catches missed updates and defaults
to five minutes. Existing settings at the previous one-minute default move to
five minutes on upgrade. Other intervals are preserved.
Account WebSockets reconnect after disconnection, and expired listing sessions
are logged in again. The page reports discovery and login errors per account.
The next scheduled poll retries the affected accounts.

Training scripts continue to use `default-weights.json` as their fixed baseline.
The managed player loads older checkpoints from `live-player/models.json` and
the baseline from `live-player/human-baseline.json`. See
[training and release evaluation](human-policy.md).
The standalone worker still supports `NATIONS_PLAYER_WEIGHTS`.

## Open-beta challenges

Use `/challenge` in Discord and accept the resulting invitation in Tabony.
The command reuses your saved Tabony name or tries your Discord nickname,
display name and username against known Tabony players. Use
`/challenge nationsname:YourTabonyName` to enter the exact name yourself.
Discord-created games use the mixed-training distribution for difficulty,
draft size, weighted card draw and the Korea and Lincoln rules. Titles look like
`Kayser vs. NationsBot20 · 2026-11-21 14:57:00 UTC`.

You can also create a 1v1 match in Tabony and invite the beta bot account.
Those games use the settings chosen by their creator. If a restriction such as
an unfinished challenge or the daily limit prevents acceptance, the bot posts
the reason in the match chat and keeps its seat reserved. It automatically
accepts the pending invitation once the restriction clears.
Across both methods, each Tabony username can have one unfinished challenge
and start five challenges per UTC calendar day. Each Discord account can also
have one unfinished challenge started through `/challenge`, even if it supplies
different Tabony names. A Discord invitation holds both slots while it awaits
acceptance. The daily limit resets at midnight UTC.

Set `NATIONS_PLAYER_CHALLENGE_ACCOUNT` to enable this on one regular account.
Start the account and enable 2-player games and service-wide playing.
Enable automatic invitation acceptance for the Tabony entry point and automatic
discovery for unattended play. The account's game connection limit still
controls how many games it plays at once. Challenge history and pending attempts
are saved in `/data/player-challenges.json`. If creation is interrupted after
confirmation was submitted, discovery looks for the unique match title before
allowing a second challenge for that player.

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
The default for new two-player games is **Experimental RL · 100,000 games · 556d1e2a**,
the mixed-settings checkpoint. Existing seat pins and account overrides take precedence.

Run `npm test` and `node --test --test-isolation=none live-player/*.test.mjs`
before release. The latter includes persistence, profile selection, discovery,
invitation confirmation, access revocation, coalescing and private API checks.
