# Bulletin publication API

Bulletins are drafted and approved in the conversation. The local CLI calls a limited HTTPS API on the existing admin origin; publication does not require the Railway web console or the Discord bot token on the local computer. There is no automatic publication on deploy.

## Setup

Create **different keys** for the two environments. Files ending in `.secret` are ignored by Git. Keep them private and outside any shared artifact directory:

```powershell
node scripts/create-bulletin-key.mjs staging .data/bulletin-staging.secret
node scripts/create-bulletin-key.mjs production .data/bulletin-production.secret
```

Install only the printed `sha256` as `NATIONS_BULLETIN_API_KEY_SHA256` on that environment's bot service. The original key stays local. The endpoint remains unavailable when no valid hash is configured. Changing the configured hash revokes the previous key. These credentials authorize only bulletin endpoints, not the owner panel, subscriptions, question logs or settings.

The existing environment name and Discord client/guild/channel configuration determine the bot and destination. Clients cannot supply a different channel. Staging therefore uses the staging bot and configured test channel; production uses NationsBot20 in the configured `#nationsbot20` channel. Every publication verifies the actual bot identity, guild and channel through Discord before sending. HTTPS and exact Host are required; an unrelated Origin is rejected. The public asset server does not expose this API.

## Review, publish and verify

The CLI reads the Markdown file and trims surrounding whitespace. Keep the final text at 2,000 UTF-16 code units or less. It rejects explicit mentions; Discord also receives empty allowed-mention lists. A single bulletin is one Discord message; split longer announcements into separately approved bulletins.

```powershell
node scripts/bulletin.mjs preview --environment staging --key-file .data/bulletin-staging.secret --file docs/bulletin-2026-10-17.md
node scripts/bulletin.mjs publish --environment staging --key-file .data/bulletin-staging.secret --file docs/bulletin-2026-10-17.md --id faq-amendments-20261017 --confirm-hash <sha256-from-preview>
node scripts/bulletin.mjs status --environment staging --key-file .data/bulletin-staging.secret --id faq-amendments-20261017
```

For production repeat the preview and publication using `--environment production` and the separate production key file. Review the environment, target, full text and hash before publishing. Publishing a staging test does not authorize production publication; obtain the user's approval for the exact public text and destination.

Routes:

| Method/path | Purpose |
|---|---|
| `POST /api/bulletins/preview` | Validate `{environment, content}` and return text, destination and SHA-256; sends nothing. |
| `POST /api/bulletins` | Publish `{environment, content, sha256}` with a stable `Idempotency-Key` header. |
| `GET /api/bulletins/<id>` | Read the persistent receipt. |

All routes use `Authorization: Bearer <64-hex-character-key>`. The CLI's origins are fixed to the known staging/production admin domains. It never prints the key and does not follow redirects. Receipts include the approved text/hash, environment, fixed destination, timestamp, nonce, delivery status and verified message URL.

## Retries and recovery

Receipts are stored under `/data/bulletins/<id>.json` on each environment's own persistent volume. The service reserves the key **before** posting. Reusing it with a different text fails. Reusing it after a verified publication returns the original receipt, including after a restart. Concurrent requests cannot independently post the same key. Discord also receives a stable nonce with `enforce_nonce`.

If Discord's acknowledgement is lost, the receipt remains `uncertain`; **the service never automatically posts again**, even if its original reservation survived a process crash. Repeating the same publish request only attempts to find/verify the original message using its ID or nonce among the last 50 channel messages. A verified match changes the receipt to `verified`; it does not send a new message. `sent` means Discord returned a message ID but the independent readback has not succeeded yet. `failed` means Discord explicitly rejected the POST; no automatic retry occurs.

The CLI exits unsuccessfully for nonverified publication results, including HTTP 202. Inspect status and the channel before deciding on any new publication key. An old uncertain message outside the last 50 messages requires manual investigation. Corrupted or unwriteable receipts fail closed. Receipt files must not be deleted as a way to retry.

This is separate from turn reminders and their delivery accounting. It does not log into games, change matches, spend question quotas or call a language model. The existing single-replica deployment remains the supported configuration.
