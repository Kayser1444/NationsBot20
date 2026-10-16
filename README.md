# Nations Bot 2.0

The opt-in `/question` pilot answers rules and implementation questions using
local FAQ and Tabony source snapshots. See [setup and limits](docs/question.md).

A standalone Discord reminder bot for the online Nations board game at
https://games.tabony.net/nations/. It observes public game information without
logging into the game, submitting moves or posting game chat.

## Quick links

- [NationsBot administration console](https://nationsbot20-production.up.railway.app/) — subscriptions, monitoring status and logs; sign in with the configured Discord owner account.
- [Railway production service](https://railway.com/project/54e5d506-6518-484c-bbd6-2e5dd7449c80/service/5f489d1a-3442-45c3-b8cb-4b07cd4d4ce3?environmentId=4ae89d35-d82d-42e1-b5cd-2132cc248db0) — deployments, service logs, variables and volume settings; Railway access required.
- [Nations on Tabony Games](https://games.tabony.net/nations/) — the online game, ongoing games and match pages.
- [GitHub repository](https://github.com/Kayser1444/NationsBot20) — maintained source code and CI.
- [Discord application settings](https://discord.com/developers/applications/1558936899446374570) — NationsBot 2.0 bot and OAuth settings; application access required.

English commands with replies in Swedish, English, German, French, Spanish or Simplified Chinese:

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
  English. Typeahead suggests sv-SE, en-US, de, fr, es-ES, zh-CN and `auto`.
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
capture happens when users invoke commands; it does not sample the
server member list. Delivery history lives separately in `friends-outbox.json`.

## Current observation method

The bot scans public ongoing-game lists every five minutes and maintains one
spectator WebSocket per watched game, shared between subscribers. A
full-state check runs every five minutes on each connection; move updates still
arrive immediately. Connections reconnect after more than ten minutes without
a response, checked at the five-minute interval. A separate
fresh state check validates pending reminders before delivery. Outages are retried;
subscriptions, preferences, queued reminders and confirmed turns are persisted.
Ambiguous Discord acknowledgements can still cause duplicate messages.

The [draft server-feed PR](https://github.com/Logitude/TabonyGames/pull/2) proposes
a single metadata/turn feed to replace scraping. This notifier does not yet use
that feed; it can be hosted independently of that PR's deployment.

## Railway staging

[Staging service](https://railway.com/project/54e5d506-6518-484c-bbd6-2e5dd7449c80/service/706a9b41-d46e-4e16-84a2-4e97b27f455a?environmentId=99f87381-4455-43f3-99fa-b7bb9a6c1495)
uses the `staging` Git branch; production continues to use `main`.
The environments have separate Discord credentials, destinations and volumes.
Staging uses the NationsBot Dev application on the personal test server.

Settings: Dockerfile builder, Wait for CI enabled, one replica, Serverless off,
On Failure restart policy (10 retries), and its own volume mounted at `/data`.
Use `NATIONS_DATA_DIR=/data`, the test server/channel IDs and the test bot token
as `NATIONS_DISCORD_BOT_TOKEN`. Do not copy production variables or migration
bundles. The [staging owner panel](https://nationsbot20-staging-admin.up.railway.app/)
uses port `8080`, Discord test-app OAuth and the configured owner ID. Its callback
is `/auth/callback`; its client secret stays in staging's Railway variables.
The existing `nationsbot20-staging-staging.up.railway.app` domain continues to
serve card images on port `8081`. The question log is on staging's own volume.

Stop the local testbot with Ctrl+C before starting staging: both use the same
Discord application. Stop staging before returning to local Discord testing.
Test subscriptions start empty and persist only on the staging volume.

Release workflow:

1. Commit the intended feature on a feature branch, run the automated checks,
   then fast-forward `staging` to that commit and push it. Do not force-push.
2. Verify Railway builds the Dockerfile and starts the bot. Check deployment logs
   for Discord readiness; use the test bot's `/help`, `/status` and a test
   subscription in the test channel. Check channel and DM reminders as needed.
3. Restart staging and confirm subscriptions persist and Discord reconnects.
4. After approval, fast-forward `main` to the **same tested commit** and push it.
   Confirm production's deployed Git SHA matches staging's tested SHA. Any new
   code or merge commit must be tested again before promotion.

Do not deploy uncommitted working files as a release candidate. Staging proves
that its own build and configuration work; production credentials and volume
contents still differ. Staging consumes Railway credits while running.

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

The admin subscriber table counts each Discord user once across turn notifications
and enabled daily reminders. It includes reminder-only users, labels each delivery
subscription type, and shows the union of their watched games. **Avsluta alla**
ends both types for the selected user; other users following the same player keep
their subscriptions. Disabled reminder preferences and historical accounts do not
count as active subscribers.

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
Login starts are limited to 20 per client IP in a five-minute window, with at most
five pending flows per client. The pending-flow cache holds at most 1,000 entries;
when full, a fresh flow replaces the oldest rather than blocking all new logins.
Distributed traffic can therefore expire an older pending flow, requiring a fresh
sign-in, while single-use state and browser binding remain enforced. Cloud mode
uses Railway HTTP ingress's validated `X-Real-IP`; absent or invalid values fall
back to the socket address. Keep the application port behind that ingress, which
must overwrite client-IP headers; do not expose it through a TCP proxy or a proxy
that passes user-supplied `X-Real-IP` unchanged. Clients sharing an IP share the
login limit. The local console does not use forwarded client-IP headers.
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

## Local development with live Discord

Run a separate **NationsBot Dev** application in a test channel on the existing
Nations Discord server. Production continues on Railway while this bot runs on
your computer. No public URL, tunnel or Railway deployment is needed for Discord
commands and reminders; the local bot connects outbound to Discord's Gateway.

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create a new application named **NationsBot Dev**. Copy its Application ID.
   Obtain its own bot token in the Bot settings; keep it private.
2. Install this new application on the existing Nations server using Guild Install
   with `bot` and `applications.commands` scopes. Give it **View Channel** and
   **Send Messages** in a dedicated test channel such as `#nations-bot-dev`.
   Review channel overrides so it only has the access needed for testing.
   No Administrator or privileged Gateway intents are needed.
3. Enable Discord Developer Mode and copy the test channel's ID. The default
   server ID in the example is the existing Nations server.
4. From this repository, install dependencies once and create the private config:

   ```powershell
   npm ci
   Copy-Item dev.env.example .env.dev
   ```

   Fill in the development application ID, bot token and test channel ID in
   `.env.dev`. Never paste the token into chat or commit it. This file is ignored
   by Git. Production environment variables are not used for these credentials.
5. Start the local bot:

   ```powershell
   npm run dev
   ```

   Open [the local development console](http://127.0.0.1:24682). The console is
   local to this computer; it does not test the production HTTPS/OAuth login.
   Stop with Ctrl+C. Restart the command after changing code or `.env.dev`.

The launcher checks the token's application identity and channel/server before
starting. The known production application and reminder channel are refused.
Configuration, subscriptions, caches, logs and delivery history are kept under
`.data/dev/`, separate from production and other local profiles. An existing dev
configuration with a different destination refuses startup. It starts with no
subscriptions; production subscribers and pending reminders are never imported.
The test bot observes real public Nations games and sends real Discord messages
and DMs for its own subscriptions. Only subscribe willing testers.

Commands that change notifications, DM mode or language are limited to five per
Discord account per ten-second window. `/status`, `/help`, `/smtable` and autocomplete
remain available during that cooldown. A new subscription or a change from channel
delivery to DM can send a control DM, at most once per account per minute; repeating
an already active subscription does not send another control. These short limits
are held in memory and reset on a bot restart. The outbox retains per-user receipts
for the currently observed turn across unsubscribe/resubscribe and restarts, so
off/on does not replay a confirmed reminder. New recipients and observed turn
changes still receive their reminders. Malformed game frames are ignored by both
the observer and the fresh check before delivery.

### Smoke test and release workflow

- In the test channel select commands belonging to **NationsBot Dev** (Discord
  may also list the production bot's commands). Run `/help`, `/status` and
  `/notifications on nationsname:<your-name>` and check the local console.
- Check channel reminders for a real pending turn, then try DM delivery with
  `/notifications on dm:on`. Test `/language` and `/notifications off` as needed.
  Starting a subscription while your turn is pending can immediately remind you.
- Use the local console to test subscription changes, user details and blocking.
  Check `.data/dev/friends.log` for failures. Test state persists between runs.
- Develop on a feature branch, run `npm test` and the runtime checks below, then
  test against Discord with `npm run dev`. Keep unapproved work off the Railway
  deployment branch (`main`). Pushing or merging into that branch can deploy it;
  starting the local test bot does not deploy anything.

Discord setup reference: [official quick start](https://docs.discord.com/developers/quick-start/getting-started).

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

### Card inventory and FAQ

`/card name:Porcelain Tower` shows the card image, a compact type/age row and
the linked FAQ++ 1.11 points, including imports pending review. All 216 FAQ entries
have Swedish text as well as the preserved English version. FAQ is expanded
in the initial reply; **Show FAQ / Hide FAQ** updates the same card message. Each point
identifies its original heading and page. Long answers have previous/next page
buttons, and closing the FAQ leaves no extra messages behind. Swedish and English follow
the caller's language preference. Successful server replies are public in the
calling channel; DM replies stay in DM. Existing bans and DM membership checks
apply, and no reminder subscription is required. Unknown or unsupported card
names receive private help in server channels.

The expanded state is shared by everyone viewing a public card message. Button
clicks retain the card's original language and recheck bans and DM membership.
The buttons continue working after a local bot restart while the same card remains
available. Run `npm run dev` and use `/card name:Porcelain Tower` from **NationsBot Dev**
to try it locally; the production bot is separate.

The inventory enables 526 entries across all card types, including 17 nations,
starting-board variants and the special cards named in FAQ++ 1.11. All 479 FAQ card
headings map to the inventory. 422 public Tabony card images have been checked.
The 74 starting cards are extracted from Tabony boards. Nation entries use 17 supplied
player boards with printed starting resource amounts (base B sides and expansion D sides).
These and 12 supplied/local promo-card scans make 103 local files served by a separate
Railway image listener. Hussar still lacks a complete card image. Promo entries explicitly
state that they are outside the Tabony game implementation. `/nation name:China` shows
the resource board and both of that nation's dynasty cards. Its FAQ contains the nation
rules; dynasty FAQ remains available by looking up the dynasty itself with `/card`.
Nation suggestions live in `/nation`, with Swedish aliases such as `Kina`. Existing
`/card` nation lookups and FAQ buttons remain compatible.
Relevant owner-documented Tabony rules differences also appear immediately in a
separate Tabony errata section after the FAQ. Each section has its own point count
and source link. Owner notes are translated into all six supported languages.
Nation lookups include notes for their starting cards and dynasties. Named card
references and explicit private-architect abilities determine relevance; historical
MaBiWeb comparisons remain labelled separately from differences with official rules.
The daily local snapshot is shared with `/question` and refreshes even when paid
questions are disabled. Long FAQ/notes use the existing page buttons.
Search aliases include `Tom's Cabin` for `Uncle Tom's Cabin`. Suggestions distinguish
cards sharing a name by type, age and starting nation. All 34 dynasty entries identify their nation.
The first reply uploads the image as a Discord attachment; FAQ edits retain it,
including after bot restart. Hidden embedded files retain their IDs and `attachment://`
references on every edit; converting them to CDN links exposes duplicate standalone images.
Nation replies retain all three image attachments together. Remote downloads have bounded caching, size and timeout
limits and fall back to the source URL on failure. Local images need no HTTP fetch.
The FAQ bank contains 216 text entries; 206 remain pending review. Pending points
and links are visible without a review disclaimer, while rejected content stays hidden.
Swedish replies use Swedish text consistently; English replies use the English
version. Every point keeps its source page, and each FAQ page links to the original
English FAQ++ PDF for verification. Card-type rules and explicit references are included
once each. Empty card headings do not create FAQ points. Displaying content does
not change its review status. See [card coverage and image checks](data/cards/README.md),
[FAQ data and reproduction](data/faq/README.md) and
[content review](data/faq/review.md). The Docker build includes the runtime JSON
files, extracted starting-card PNGs and the 17 resource board JPEGs; source PDFs stay local. The expanded catalog is deployed to
the separate Railway staging service; production remains separate.

Message splitting and embed limits follow the
[Discord message documentation](https://docs.discord.com/developers/resources/message).

## License

MIT. This repository contains the notifier, not the Nations game engine or assets.


### Svenska mästerskapet

`/smtable div:1A`, `div:2A` eller `div:2B` visar en publik tabell i valfri kanal på alla servrar där boten finns. Utan `div` används Nations-namnet från avsändarens aktiva prenumeration. Tabellen visas direkt i DM när kommandot körs där, annars publikt i serverkanalen. Automatiskt vald grupp markeras i rubriken. Övriga kommandon behåller sina privata svar. Endast valet av kanalpåminnelser kräver SM-serverns påminnelsekanal. Om serverns Integrations-inställningar begränsar kommandon till påminnelsekanalen behöver `/smtable` ges tillgång till övriga kanaler där det ska användas.

`sm-season.json` är den manuellt granskade säsongslåsningen: säsong, deltagare och exakt parti-ID för varje grupp. Säsong 11 har 21 låsta partier. SM-tabeller tar aldrig in nya parti-ID:n från matchsökningen. Vid nästa säsong uppdateras och kontrolleras låsningen manuellt, sedan startas bevakningen om. Ett ändrat säsongslås gör den gamla diskcachen ogiltig.

Vänprofilen bevakar samtliga låsta partier även utan prenumeranter, med samma anslutningar som turbevakningen. Aktuella snapshots räknar om tabellen i minnet. `.data/sm-table-cache.json` sparar senaste ställning och slutresultat över omstarter. Pågående partier visas som inaktuella tills en färsk snapshot kommit; avbrott eller mer än 60 sekunder sedan senaste livstecken eller spelställning markeras i svaret. Saknas något parti helt visas ett väntemeddelande i stället för en ofullständig tabell. Slutresultat behålls när ett parti avslutas.

Matchplacering: total-VP, resursrest och därefter aktuell turordning (tidigare spelare först). Placeringen ger 5/3/2/1 grupppoäng. Tabellens skiljekriterier följer §7: vinster, andraplatser, grupppoäng/vinster/andraplatser/VP i inbördes möten. Vid fler än två lika spelare beräknas inbördes möten för hela den bundna gruppen. Helt olösta lika ställningar visas som delad plats i livetabellen; boten lottar inte en ny ordning vid varje uppdatering.

Partier i Nations-valet (round 0, Drafting Phase) bevakas men ger inga grupppoäng innan spelstart. Dessa partier anges uttryckligen i tabellsvaret.

Slash commands are registered globally for server channels and the bot’s own DMs (guild installation only). DM calls verify membership in at least one server where the bot is currently installed (with a bounded lookup deadline; failures deny access) before accessing subscriptions, and honor user bans. /smtable replies directly in the DM without a separate dm option. All commands, including /smtable, work in every channel of every installed server. New communities need no server settings and receive reminders only by DM. The configured guild/channel remain the SM channel-delivery exception: dm:off is accepted only there, including for existing users. Enabling notifications elsewhere or in DM without an explicit delivery choice selects DM, even if the user previously selected SM channel delivery. Subscriptions and preferences are shared by Discord user ID, so joining multiple communities does not duplicate reminders. Existing owned guild command registrations are removed after global registration succeeds to avoid duplicates.

SM standings, tiebreaker labels, warnings and automatic division labels use the caller’s effective Swedish/English language preference, matching other commands. Language is applied when rendering; every user shares the same cached standings.


### Preparing public community invitations

Before making invitations available, enable **Public Bot** in Discord Developer Portal and provide a guild-install invitation with the `bot` and `applications.commands` scopes. New servers require no setup commands, reminder channels, or per-server configuration. The existing SM guild/channel configuration remains required for the existing delivery service. No new privileged gateway intents are required.

This code update does not change Developer Portal settings or deploy the service. Validate on a second server before publishing invitations: subscribe, receive a test DM and reminder, verify that dm:off is rejected there, and run /smtable. Test DM commands with an account that belongs only to the second server. Membership checks authorize commands; they do not automatically remove existing subscriptions when a member leaves a server.


### Dagliga påminnelser och betänketid

`/reminders on` aktiverar en påminnelse per 24 timmar sedan botten observerade att det blev spelarens tur. `/reminders on time:18:00` påminner varje dag klockan 18:00 GMT. Ange till exempel `timezone:Europe/Stockholm` för lokal tid med automatisk sommartid. `time` måste vara HH:mm och `timezone` en giltig IANA-tidszon. `/reminders off` påverkar inte `/notifications`, och `/notifications off` påverkar inte dagliga påminnelser. Spelarnamnet kan anges med `nationsname`; annars återanvänds kopplat eller tidigare sparat namn, alternativt matchas Discord-namnet. Leveransen följer sparat DM/kanalval. Påminnelser är avstängda som standard.

Schemaläggaren kontrollerar var 30:e sekund och verifierar den aktuella turen före leverans. Leveranskvitton sparas över omstarter. Missade dygn sammanfattas med en aktuell påminnelse; gamla påminnelser skickas inte i klump. En upprepad timme vid övergång till vintertid ger inte dubbla påminnelser; ett klockslag som saknas vid övergång till sommartid hanteras vid nästa kontroll efter tidshoppet. Leveransfel försöks igen efter minst 15 minuter. Ett avbrott precis mellan Discord-leverans och sparat kvitto kan medföra en upprepning.

Ägarpanelen låter dig välja **Mät betänketid** för ett parti eller ange dess ID under **Betänketid**. Alla spelares observerade intervall sparas, även om samma spelare gör flera drag i följd. Pågående intervall visas också. **Stoppa mätning** avslutar intervallet och behåller loggen. Val och logg lagras i `<profil>-turn-journal.json` under tjänstens datakatalog (`NATIONS_DATA_DIR`), separat från händelseloggen. Första intervallet och intervall vid anslutningsavbrott markeras som ofullständiga. Obevakad tid under avbrott tilldelas inte någon spelare. Historiska turbyten före aktivering kan inte återskapas; tiderna bygger på när botten observerar spelstatus, inte serverns historiska dragtider.

Språkval: svenska (`sv-SE`), engelska (`en-US`), tyska (`de`), franska (`fr`), spanska (`es-ES`) och förenklad kinesiska (`zh-CN`). `/language locale:auto` följer Discord-språket, med engelska som reserv. FAQ-texten finns på alla sex språk. Kortbilder och tryckta kortnamn behåller sina befintliga språk; källhänvisningar länkar till den engelska FAQ:n.


### Flerspråkig FAQ

Samtliga 216 FAQ-poster (219 engelska svarspunkter) har översättningar till tyska, franska, spanska och förenklad kinesiska, utöver de befintliga svenska texterna. `/language` styr även FAQ-text och allmänna frågerubriker i `/card` och `/nation`. Tryckta kort- och nationsnamn, versionsreferenser, källsidor och källänkar bevaras. Knappar och sidindelning behåller det valda språket.

De fyra nya språken är maskinöversättningar från Google Translate med en gemensam spelordlista och stickprovskontroll av regeltolkningar. De är `pending` i granskningsunderlaget och är inte officiella eller fullständigt innehållsgranskade översättningar. Visningen följer samma befintliga regler för `pending` och `rejected` som övrig FAQ. Ingen översättning godkänns automatiskt.

Redigera `data/faq/translations-{de,fr,es,zh}.json` och kör `node scripts/apply-faq-translations.mjs` för att uppdatera FAQ-registret och granskningsunderlaget. Importen verifierar SHA-256 för dokument, källtext och varje engelsk svarspunkt, samt bevarar versionstaggar och granskningsbeslut. `node scripts/apply-faq-translations.mjs sv` återapplicerar enbart svenska. Översättningen är förberedd i Git; inga översättningstjänster anropas när botten körs.
