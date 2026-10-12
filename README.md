# Nations Bot 2.0

A standalone Discord reminder bot for the online Nations board game at
https://games.tabony.net/nations/. It observes public game information without
logging into the game, submitting moves or posting game chat.

English commands with Swedish or English replies:

- `/notifications on [nationsname]` enables turn reminders; omitted names reuse
  your last subscription or match your Discord display name.
- `/notifications off` ends your subscription.
- `/dm on` chooses private reminders and sends a control DM; `/dm off` chooses
  channel reminders. Preferences persist across restarts.
- `/status` privately lists your monitored games with links and connection status.
  Each game shows its current turn player and, for active subscribers, the Discord
  display name in square brackets as plain text without mentions. Disconnected games
  label the player as the last known turn; missing snapshots show an unknown turn.
  Individual display-name lookups are briefly cached, with no server member scan.
  It shows your effective bot language and whether it is automatic or overridden;
  the detected Discord locale is retained for automatic selection but not displayed.
- `/help` explains the bot and subscription rules.
- `/language locale:sv-SE` selects Swedish; `/language locale:en-US` selects
  English. Typeahead suggests both supported languages and `auto`.
- `/language locale:auto` removes your override and follows your Discord locale.
  Swedish locales use Swedish; English variants and unsupported or unknown locales
  use English. Commands update the remembered Discord locale automatically.

Language preferences apply to command replies, control DMs and your turn reminders
in either delivery mode. The preference survives unsubscribe/resubscribe and restarts.
Shared startup/shutdown notices remain Swedish. Translation text lives in
`messages-sv.mjs` and `messages-en.mjs`, separate from command logic.

Nations names are case-sensitive. Discord display-name matching is case-insensitive
and strips a trailing parenthesized name. One Nations name can have one subscriber.
Reminders use the bot account, with mentions in the channel unless DM is enabled.
Startup/shutdown notices go to the channel without mentions.

Subscriptions and user preferences are saved in `/data/friends.json` on Railway's
persistent volume: `subscriptions`, `lastNationsNames`, `dmPreferences` and
`userLocales` (last observed Discord locale) plus `languagePreferences` (explicit
bot language overrides), keyed by Discord user ID. Locale
capture happens on commands in the designated channel; it does not sample the
server member list. Delivery history lives separately in `friends-outbox.json`.

## Current observation method

The bot scans public ongoing-game lists every five minutes and maintains one
spectator WebSocket per watched game, shared between subscribers. A separate
fresh state check validates pending reminders before delivery. Outages are retried;
subscriptions, preferences, queued reminders and confirmed turns are persisted.
Ambiguous Discord acknowledgements can still cause duplicate messages.

The [draft server-feed PR](https://github.com/Logitude/TabonyGames/pull/2) proposes
a single metadata/turn feed to replace scraping. This notifier does not yet use
that feed; it can be hosted independently of that PR's deployment.

## Railway deployment

Use one persistent service, with **Serverless disabled**, **one replica**, and no
public domain or port. The local administration dashboard is disabled in cloud
mode; subscribers use Discord commands. Railway's deployment logs and metrics
provide operator status. The trial's outbound networking must permit Nations and
Discord connections.

1. Connect Railway to this repository and select the Dockerfile builder. Its Dockerfile installs the locked Node.js
   dependencies and runs `node start-cloud.mjs`.
2. Attach a persistent volume mounted at `/data`. In service settings, use one replica, disable Serverless, and set restart policy to On Failure (10 retries). New services cannot opt into Railway's deprecated config-as-code; configure these settings in the dashboard.
3. Set these service variables:

   | Variable | Value |
   |---|---|
   | `NATIONS_DATA_DIR` | `/data` |
   | `NATIONS_DISCORD_GUILD_ID` | Discord server ID |
   | `NATIONS_DISCORD_CHANNEL_ID` | Reminder channel ID |
   | `NATIONS_DISCORD_BOT_TOKEN` | Bot token, stored as a Railway secret/variable |

4. Complete the migration below **before starting the real cloud service**.
5. Confirm startup logs show game connections and the bot's registered commands.
   Test `/status` and `/dm on` in the designated Discord channel.

If `/data/friends.json` is absent, first startup creates an empty subscription
configuration from the destination variables. It never saves the token. If the
file already exists, its subscriptions and preferences are retained; a conflicting
destination refuses startup. Secrets and live configuration must never be committed
to GitHub. Back up the volume, especially before the free trial expires.

### Moving an existing local instance

Stop the local monitor first with Ctrl+C and allow delivery to finish. Keep the
cloud instance stopped while transferring:

- Current local `friends.json` to `/data/friends.json`.
- `.data/friends-outbox.json` to `/data/friends-outbox.json` (queued reminders and
  confirmed turns, needed to avoid restart duplicates).
- `.data/player-names.json` to `/data/player-names.json` (optional cached typeahead).

Use the current files after stopping, not an old snapshot. Never transfer
Windows-encrypted `*.secret` files; supply the bot token privately in Railway.
Alternatively, set a temporary private `NATIONS_MIGRATION_BUNDLE` variable to the
base64-encoded JSON `{ "version": 1, "config": <friends.json object>, "outbox":
<friends-outbox.json object> }`. First startup imports it into a new volume;
destination mismatches or existing different state are rejected. A persisted
completion marker prevents later restarts from overwriting subscription edits.
Remove this variable after verifying migration. The player-name cache rebuilds
automatically if omitted. Never commit the bundle to GitHub.
Start only the cloud instance. To roll back, stop the cloud instance and download
its latest configuration/outbox before restarting locally. Do not run both copies
against the same reminder channel.

## Local development

Install Node.js 24, then:

```sh
npm ci
npm test
node tests/discovery-runtime.mjs
node tests/subscriptions-runtime.mjs
```

Tests use synthetic configuration and mocked game/Discord traffic; they do not
send real notifications. The dashboard test binds a loopback port.

For a local run, copy `friends.example.json` to ignored `friends.json`, set the
Discord IDs and `NATIONS_DISCORD_BOT_TOKEN` in your shell environment, and run:

```sh
node watch-kayser.mjs --config friends.json
```

This enables the administration dashboard at `http://127.0.0.1:24680` only on the
local machine. The existing local prototype and Windows launchers can continue
to run independently until the deliberate cloud cutover.

## License

MIT. This repository contains the notifier, not the Nations game engine or assets.
