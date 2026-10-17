# Local Nations questions

`/question question:…` investigates Nations rules and the Tabony implementation.
This is an experimental feature. The command is registered alongside other commands but
does not perform AI requests until explicitly enabled. These changes are local;
deployment and a real-model smoke test are separate steps.

## Railway staging

Keep the `OPENAI_API_KEY` secret. Add `NATIONS_QUESTION_ENABLED=1` and
an `OPENAI_API_KEY`. When enabled, questions are available to all users who pass
the bot's existing Discord membership and ban checks. The legacy
`NATIONS_QUESTION_USER_IDS` setting is ignored; the admin owner ID controls only
administration, not access to questions. The API key alone never enables the feature.

Use the existing single replica and persistent `/data` volume. Cloud startup
prepares `NATIONS_CONFIG_DIR`; the question service stores its data in a `questions`
subdirectory. Local development uses its own configuration directory.

Model: **`gpt-6.1-sol`**, fixed, with no fallback or automatic API retry.
The question and selected source excerpts are sent to OpenAI. The investigation
has no web search, MCP, shell, code execution or ongoing-match tools. Existing
turn monitoring and image delivery keep their existing network connections.

## Source copies

### Inofficial FAQ amendments

`data/question/inofficial-faq-amendments.json` contains 28 English editorial summaries of
[Logitude's Nations FAQ += 2 post](https://boardgamegeek.com/thread/3605801/article/46844956#46844956),
published November 5, 2025 and read in Chrome on October 17, 2026. Logitude reports answers
from Rustan and Robert, rewritten in his own words as proposed additions to the official FAQ.
The canonical source label is **Inofficial FAQ amendments**. This is separate from published
FAQ++ 1.11 and the Tabony owner's implementation-difference notes.

All entries are available to `/question` through bounded local search/read tools under
`faq-amendments/…`; reading one appends the fixed BGG thread link to the answer.
Relevant named cards, their nations and private-architect providers also show these summaries
in a separately cited section of `/card` and `/nation`, with existing pagination and language
selection retained. Summaries are currently English; other language views explicitly label
them as English summaries. `/question` can explain the source in the requested language.
General clarifications without specific card links remain searchable in `/question`.

This is a bundled, manually maintained snapshot: no BGG requests or CAPTCHA interaction happen
at bot runtime. To update it, reread the post, revise the summaries and capture date, check
named card references, and run `tests/question-amendments.test.mjs` and the full test suite.

The packaged seed in `data/question/tabony-snapshot.json` preserves the Python
source, LICENSE, copyright notice, commit ID and per-file SHA-256 hashes from the
unmodified local `Logitude/nations` clone at
`9c344205b1802c9583d20c749b89a4cfa52516f7`. This JSON is reference data, never executed.

A separate updater attempts a fetch at startup when due, then checks the schedule
hourly. A persisted attempt timestamp limits it to once per 24 hours, including
after restarts and failed attempts. It resolves a fixed public GitHub `main` to a
commit, then downloads a fixed list of source files from that commit. It sends no
GitHub token. Redirects, arbitrary repositories and question-supplied URLs are not
allowed. Downloads have time and size limits.

Only a complete, validated snapshot is atomically published to
`questions/tabony-snapshot.json`. Failure retains the previous version or bundled
seed. Each question holds one immutable in-memory snapshot throughout. Answers
end with the last successful fetch date and time in Europe/Stockholm and the
12-character commit, e.g. `AI-tolkning · Tabony-kod hämtad: 2026-10-15 22:00
(9c344205b180)`. This is the source-copy refresh time, not the upstream commit date
or the answer generation time. No routine deployed-version disclaimer is appended.

The Tabony owner's [Rules Differences post](https://games.tabony.net/forum/viewtopic.php?p=4#p4)
is also captured locally. The bundled seed and [readable review copy](../data/question/tabony-rules-differences.md)
retain eight separate snippets: two comparing Tabony with official rules and six
comparing Tabony with historical MaBiWeb behavior. These are implementation notes,
not official board-game errata. Context supplied by the bot owner identifies
MaBiWeb as a discontinued earlier implementation by another creator; only mention
it when relevant.

A separate updater downloads only that fixed public post URL, anonymously, with
redirects refused, a 15-second timeout and a 250 KB bound. It extracts post `p4`
by Logitude and validates the two comparison sections before publishing. The
24-hour attempt marker survives restarts; an hourly check refreshes when due.
Failed downloads or parsing retain the last complete copy, with the bundled seed
as fallback. Questions read an immutable local snapshot, never the live forum.
The cache is `questions/tabony-rules-differences.json` with a separate sync marker.
The Discord bot shares one daily updater between `/question`, `/card` and `/nation`;
card/nation replies show the relevant notes immediately alongside expanded FAQ,
including when paid questions are disabled. Card replies show FAQ first and a
separately counted Tabony errata section second. The reviewed translation bundle
`data/question/tabony-rules-differences-translations.json` covers all captured notes
in the five non-English bot languages. Each translation matches exact English
source text: newly changed notes temporarily show labelled English until their
translations are updated. Original English evidence remains unchanged for `/question`.

Notes have `tabony-rules-differences/official-N` or `mabiweb-N` IDs, owner attribution,
capture time and the exact post URL. If the investigator reads a note, the
application appends the fixed URL to its answer, before the final code-capture
stamp. Model-generated external links are still stripped. No forum credentials,
other posts, house-rule links or live games are fetched by this updater.

The corpus includes Python code, original English FAQ++ 1.11 entries, and the
English base-game and Dynasties rulebooks in [page-addressable Markdown](../data/rules/README.md).
Each page has an edition, PDF page number and source checksum. The importer fixes
overlapping text and ligature spacing, uses explicit reading regions and labels
visual annotations separately. Full independent proofreading is pending; tiny
card/board artwork is not a complete card catalogue. The prompt distinguishes
rulebook/FAQ evidence from implementation and flags gaps or unreviewed extraction.
Website code is not included. Generated answers do not modify `/card` summaries.

The [English card effect library](../data/cards/library/README.md) adds all 526
catalogue identities, 99 image-reviewed event effects on 50 event cards, and
implementation-derived descriptions/fields for other cards where available.
Unreviewed printed text and metadata-only records are explicitly labeled.
Use `search_cards` for remembered effects and forgotten names, then read the
candidate source. The initial prompt lists a compact card index rather than all
575 card/effect records, reducing repeated context cost.

Card lookup accepts `card_type=event` (or `all`); event wording also narrows the
lookup to events. Gain/take/give and lose/return synonyms are normalized. Ranking
prefers an action tied to its resource, so taking Workers ranks ahead of gaining
Stone for undeploying them. Scores remain relevance, not proof or completeness.
The investigator is instructed to retry empty card lookups with shorter English
terms and read candidate cards before concluding that their effects are missing.

## Limits and isolation

Only `search_cards`, `search_sources` and `read_source` are exposed to the model. They resolve
in-memory source IDs; they cannot read arbitrary paths, credentials, subscriptions
or game state. The AI transport calls only the fixed OpenAI Responses endpoint,
rejects redirects and sets `store:false`. External links in generated text are
removed; Discord previews and mentions are suppressed. Accuracy and instruction
compliance still require evaluation even though tool access is restricted.

- One investigation at a time; a 120-second API deadline.
- One question/user/minute, five/user/UTC day, 20 overall/UTC day.
- Six API requests/question, 120 overall/UTC day.
- 5,000 output tokens/request, including reasoning and administrator translations.
- 90,000 bytes maximum serialized context/request.
- Eight local tools/API response, 100 lines or 10,000 characters/read, 14 hits/search.
- Card lookup returns at most eight ranked candidates per search.

`questions/usage.json` persists counts and last-use times before spending. Failures
and timeouts count as attempts. It stores no questions, answers or keys. Corrupt
accounting disables questions rather than resetting counters. Missing/corrupt
sources disable questions without stopping reminders. These are application work
limits, not an exact dollar-denominated billing cap. Use one replica and do not
reset the ledger to bypass limits.

## Answers and administrator log

Accepted questions first receive a quick acknowledgement with a tentative local
search hint (rulebook, FAQ, card library and/or Tabony code). This uses local
language templates and keyword routing, with no extra API request; it does not
promise which source will actually settle the question. Access/quota rejections
receive just the rejection. The acknowledgement is retained as its own message
with delivery status, timing and a local English rendering for administrator review.
The receipt includes the original question in a labeled Discord embed, which
remains visible when answer follow-ups arrive. Channels without Embed Links
permission receive the question in the acknowledgement's plain text instead.

The actual answer uses one or two follow-ups: at most three messages including
the acknowledgement. When both perspectives matter, the prompt prefers official
rulebook/FAQ/verified card evidence first, then the Tabony implementation and any
differences. This is guidance, not a required two-part answer.
Each original part is limited to 1,800 UTF-16 code units and the complete Discord
payload (numbering and source footer included) to 2,000. Overlong or malformed
answers fail validation rather than being silently truncated. Channel questions,
receipts and answer follow-ups are public in that channel; questions asked in DM
are answered only in that DM. Discord.js handles REST rate limits; failed or uncertain
deliveries are not retried and a delivered first part is never overwritten.

The existing owner panel exposes a searchable, paginated question log, protected
by its existing Discord owner session on Railway. It stores user ID/name,
server/channel IDs/names or DM, original question, original answer parts, delivery
status, total/acknowledgement/first-answer/investigation times, safe local tool
diagnostics, model, API attempt count and reported token usage. It also stores
bounded provider rejection diagnostics (HTTP status, request ID, error code,
type, parameter and a credential-redacted message). Raw error bodies and headers
are discarded; non-JSON or oversized errors retain only status and request ID.
Token totals cover only responses
that supplied usage, so failed calls may still cost money. No keys, authorization
headers or interaction tokens are logged. Conversation details are fetched
separately and are not included in the frequently polled status response.

`questions/conversations.json` is stored atomically on the data volume, retaining
at most 500 conversations for 30 days. Retention is applied on startup and new
questions; expired records are immediately excluded from reads. Interrupted work
is marked after restart. An unreadable or unwritable log blocks new investigations
without stopping reminders. Keep one replica.

The owner panel can inspect and reset a user's question quota by Discord ID,
including the signed-in owner (prefilled). A conversation detail also links to
that user's quota. Reset clears the user's five-per-day count and minute cooldown
atomically on disk, and records the target and administrator in the event log.
It does not change the global 20-question/120-request counts, bans or
conversation history. Resets are rejected while an investigation is in progress.
Both quota reads and resets require the owner session on Railway; POST resets
also require the existing same-origin and CSRF checks.

Structured model output includes detected question/answer languages and English
translations for text in languages other than Swedish or English. These are
generated in the same completion (extra output tokens, no separate API request),
shown separately with a machine-translation label, and never sent to Discord.
Originals are always retained. Missing translations are explicitly incomplete;
rejected questions or failed investigations can have no translation available.
Translation accuracy and language detection still need live evaluation.

## Validation

Run `npm test`. Tests use simulated HTTP: daily updates, upstream failures,
atomic publication, quota persistence, local-only tools, model/endpoint pinning,
context bounds and Discord handling. No paid API request is made by these tests.

### Later staging test

Local automated checks currently pass (171 tests). The feature has not been
deployed or tested against the real model. The next steps are:

1. Deploy this feature to staging with questions enabled and a persistent data
   volume. Keep the key in Railway variables.
2. Ask the question below. Check that the acknowledgement arrives before the
   investigation finishes, names a tentative search path, and is followed by at
   most two answer messages. Each message must fit 2,000 characters.
3. Open the owner panel's question log. Check identity, channel/DM, exact messages,
   acknowledgement time, first-answer time, final duration and delivery status.
4. Try a French or German question. Check the original conversation and its
   separately labeled English translation, including the acknowledgement.
5. Try a remembered card effect, a FAQ-only question and insufficient evidence.
   Check the distinction between verified card text, official rules and code.
6. Request an ongoing-match lookup: the investigation must explain that its
   local sources cannot inspect live games. Check cooldown and quota rejections
   without spending extra model requests.
7. Check reported tokens and actual project usage before widening access. Verify
   that a restart retains logs, usage counters and the last good source snapshot.

First live staging question:

`/question question:Can another player buy Poland's advisor on Porcelain Tower for 3 gold with Polish-Lithuanian Commonwealth?`

Check citations, tracing of `wonderful_advisors` and Porcelain Tower placement,
separation of FAQ and implementation, and API project usage. Also test insufficient
evidence, a FAQ-only question and a request to inspect an ongoing match. Local
tests verify orchestration, not Sol's answer quality. Never put keys in Discord
or repository files.

## Railway tools

The Railway Docker image runs Node.js and includes these sources. The model does
not inherit Codex's workstation tools. OpenAI function calling lets it request our
application functions; the bot executes them locally and returns bounded results.

For this corpus, text search and card ranking run directly in Node over a local
in-memory index. No executable, vector service, Python or OCR is needed at
question time. `ripgrep` could be installed in the Dockerfile later, but merely
installing it would not expose a tool to the model. Any wrapper would still need
to restrict source roots, arguments, output and duration. The current tools cannot
invoke a shell or read live games, arbitrary URLs, secrets or subscription files.

References: [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[function calling](https://developers.openai.com/api/docs/guides/function-calling).
