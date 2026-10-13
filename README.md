# Nations Bot 2.0

A standalone Discord reminder bot for the online Nations board game at
https://games.tabony.net/nations/. It observes public game information without
logging into the game, submitting moves or posting game chat.

English commands with Swedish or English replies:

- `/notifications on [nationsname]` enables turn reminders; omitted names reuse
  your last subscription or match your Discord display name.
- `/notifications off` ends your subscription.
- `/notifications on dm:on` chooses private reminders and sends a control DM; `/notifications on dm:off` chooses
  channel reminders. Preferences persist across restarts.
- `/status` privately lists your monitored games with links and connection status.
  Each game shows its current turn player and, for active subscribers, the Discord
  display name in square brackets as plain text without mentions. Disconnected games
  label the player as the last known turn; missing snapshots show an unknown turn.
  Individual display-name lookups are briefly cached, with no server member scan.
  It shows your effective bot language and whether it is automatic or overridden;
  the detected Discord locale is retained for automatic selection but not displayed.
- `/help` explains the bot and subscription rules.

Each Discord account can watch one Nations name at a time. Watching another
player is allowed, and any number of accounts can watch the same player. Each
recipient receives an individual reminder using their own language and delivery
preferences. Shared games still use one observer connection. To change the watched
name, use `/notifications off` followed by `/notifications on nationsname:...`.

Existing single-recipient subscription files remain readable; shared names store
an array of Discord IDs instead of a single ID. The outbox retains per-recipient
turn receipts, upgrading old confirmed turns without resending them on startup.
Admin removal and blocking affect only the selected Discord account.
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

Use one persistent service, with **Serverless disabled** and **one replica**. No
public domain is needed unless enabling the authenticated owner console below.
The administration dashboard is disabled by default in cloud mode; subscribers
use Discord commands. Railway's deployment logs and metrics
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
   Test `/status` and `/notifications on dm:on` in the designated Discord channel.

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

## Owner console with Discord authentication

The cloud console reuses the local subscription-management page, protected by
Discord OAuth authorization-code sign-in with only the `identify` scope. Access
is restricted to one configured Discord owner ID, checked by the backend on every
session. Server membership or administrator permissions do not grant access.

1. Generate a Railway HTTPS domain for this service, targeting port `8080`.
2. In the Discord application's OAuth2 settings, add the exact redirect URI
   `https://<your-domain>/auth/callback`. Keep the existing bot installation settings.
3. Set these private service variables:

   | Variable | Value |
   |---|---|
   | `NATIONS_ADMIN_ENABLED` | `1` |
   | `NATIONS_ADMIN_ORIGIN` | `https://<your-domain>` (no path) |
   | `NATIONS_ADMIN_OWNER_ID` | `229311536827465728` for Kayser |
   | `NATIONS_DISCORD_CLIENT_ID` | `1558936899446374570` for NationsBot 2.0 |
   | `NATIONS_DISCORD_CLIENT_SECRET` | OAuth client secret from Developer Portal, **not the bot token** |
   | `PORT` | `8080` |

4. Deploy and open the domain, sign in with Discord, and verify `/api/status`
   requires authentication. Test adding/removing a test subscription and logout.

The console binds to the service port only with complete, valid OAuth settings;
otherwise it stays disabled while reminders keep running. HTTPS and the exact
configured Host are required. Railway must supply `X-Forwarded-Proto: https`.
The UI and APIs require owner sessions, and edits/logout also require same-origin
requests and per-session CSRF tokens. Cookies are Secure, HttpOnly, host-only and
SameSite=Lax. Login state is browser-bound, expiring and single-use. Sessions
expire after one hour when “Kom ihåg mig” is unchecked. Remembered sessions
last 30 days (absolute expiry) and survive bot restarts via `/data/admin-sessions.json`.
Only hashes of session tokens, the owner ID, expiry and CSRF data are stored,
with private file permissions. Logout revokes the session on disk immediately.
Changing the configured owner, OAuth client or HTTPS origin invalidates saved sessions.
OAuth tokens, client secrets and raw session cookies are never saved to the volume
or exposed in the dashboard. Subscriptions remain in the existing `/data` files.
Login uses `prompt=none` to reuse prior Discord authorization; when Discord
requests interaction or consent, a fresh browser-bound flow retries with consent
while preserving the remember choice. A damaged session file disables only the
admin console; reminder monitoring continues. Deleting `admin-sessions.json`
and restarting revokes all remembered sessions.

To disable the cloud console, remove `NATIONS_ADMIN_ENABLED` or set it to `0` and
redeploy. Local runs retain the original loopback-only administration page.

### Blocking abusive users

Click a subscriber's Nations name (or a blocked user's Discord ID) to open their
live debug details: Discord ID, active/previous watched name, DM mode, effective
bot language and override source, last observed Discord locale, block state,
watched games and current turns, plus queued deliveries with failed attempts and
retry times. Details refresh with the owner panel and never expose credentials.

The owner console offers **Avsluta och spärra** beside each subscription, plus a
Discord-ID field for blocking users who have no active subscription. Blocking
atomically saves `bannedUsers` in `/data/friends.json`, releases the Nations name,
clears the user's remembered name, cancels queued reminders and closes game
connections no longer needed by other subscribers. All bot commands and
autocomplete reject blocked Discord IDs; admin subscription edits also refuse
blocked IDs. The block is specific to NationsBot, not a Discord server ban.

The blocked-user list shows the Discord ID, previous active Nations name and
timestamp. **Häv spärr** restores bot access without recreating the subscription
or restoring the old name. Preferences such as language and DM mode are retained.
Block/unblock endpoints use the same owner authentication and CSRF protection as
subscription management. A Discord message already submitted before a block
cannot be recalled; subsequent reminders are suppressed.

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


### Svenska mästerskapet

`/smtable div:1A`, `div:2A` eller `div:2B` visar en publik tabell i valfri kanal på den konfigurerade servern. Utan `div` används Nations-namnet från avsändarens aktiva prenumeration. Tabellen visas direkt i DM när kommandot körs där, annars publikt i serverkanalen. Automatiskt vald grupp markeras i rubriken. Övriga kommandon behåller sina privata svar och kanalbegränsningar. Om serverns Integrations-inställningar begränsar kommandon till påminnelsekanalen behöver `/smtable` ges tillgång till övriga kanaler där det ska användas.

`sm-season.json` är den manuellt granskade säsongslåsningen: säsong, deltagare och exakt parti-ID för varje grupp. Säsong 11 har 21 låsta partier. SM-tabeller tar aldrig in nya parti-ID:n från matchsökningen. Vid nästa säsong uppdateras och kontrolleras låsningen manuellt, sedan startas bevakningen om. Ett ändrat säsongslås gör den gamla diskcachen ogiltig.

Vänprofilen bevakar samtliga låsta partier även utan prenumeranter, med samma anslutningar som turbevakningen. Aktuella snapshots räknar om tabellen i minnet. `.data/sm-table-cache.json` sparar senaste ställning och slutresultat över omstarter. Pågående partier visas som inaktuella tills en färsk snapshot kommit; avbrott eller mer än 60 sekunder sedan senaste livstecken eller spelställning markeras i svaret. Saknas något parti helt visas ett väntemeddelande i stället för en ofullständig tabell. Slutresultat behålls när ett parti avslutas.

Matchplacering: total-VP, resursrest och därefter aktuell turordning (tidigare spelare först). Placeringen ger 5/3/2/1 grupppoäng. Tabellens skiljekriterier följer §7: vinster, andraplatser, grupppoäng/vinster/andraplatser/VP i inbördes möten. Vid fler än två lika spelare beräknas inbördes möten för hela den bundna gruppen. Helt olösta lika ställningar visas som delad plats i livetabellen; boten lottar inte en ny ordning vid varje uppdatering.

Partier i Nations-valet (round 0, Drafting Phase) bevakas men ger inga grupppoäng innan spelstart. Dessa partier anges uttryckligen i tabellsvaret.

Slash commands are registered globally for server channels and the bot’s own DMs (guild installation only). DM calls verify membership in the configured server before accessing subscriptions, and honor user bans. /smtable replies directly in the DM without a separate dm option. Other server-channel restrictions remain in force. Existing owned guild command registrations are removed after global registration succeeds to avoid duplicates.

SM standings, tiebreaker labels, warnings and automatic division labels use the caller’s effective Swedish/English language preference, matching other commands. Language is applied when rendering; every user shares the same cached standings.
