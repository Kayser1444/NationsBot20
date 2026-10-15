# English card effect library

[Browse the cards](cards.md). Runtime data is in `entries.json`, verified against
`manifest.json` before loading. Names and source text stay in English; the model
translates a user's question into an English search and replies in their chosen
language while preserving printed English card names.

## Coverage

- All **526** existing catalogue identities are represented.
- All **50 event cards** have image-verified gameplay text: **99 separately
  searchable events**, including the two promo cards. Imperium Rex has one event;
  other cards have separate A/B entries.
- The remaining card types have pinned implementation descriptions/numerical
  fields where available; some entries contain metadata only. Their printed-text
  reviews remain pending. They are not presented as image transcriptions.

Event review covers English names, effects, resource icons normalized to bracketed
labels, Architect supply and famine. It does not cover historical date captions,
artwork or set symbols. All 50 supplied images/crops were visually compared by
Codex; this does not imply user editorial approval. Review input, original file
hashes and crop coordinates are preserved in `image-reviews.json`. Local review
sheets remain in ignored `work/card-library/`.

The source-image path in a review is provenance, not a network tool or runtime
dependency. For promos, the hash identifies the original scan and the rectangle
identifies the reviewed card; generated cleanup images are not the source of the
effect text. Game code is never executed by the importer.

## Evidence boundaries

The library keeps two separate records:

1. `printed`: an explicit image review, normalized gameplay transcription and
   optional editorial search phrases. Search phrases are **not printed rules**.
2. `implementation`: descriptions and inherited numerical fields read with AST
   from the bundled Tabony snapshot. Each field retains source file/line/hash
   references and the snapshot commit. They may not cover every code path.

A daily GitHub refresh updates the actual code available to the question agent,
not the reviewed printed text or this generated description index. When the
description's pinned commit differs, implementation claims must be checked against
the current code. Printed card text can also differ from implementation behavior.
Keep such differences visible rather than reconciling them automatically.

## Offline lookup

```text
node scripts/search-card-library.mjs "lowest stability keep only two gold"
node scripts/search-card-library.mjs --read=cards/FD_HM/b
```

This returns **Hajj from Mali**, the lower event on **Feudal dues; Hajj from Mali**,
age II. Losing two Gold is a different effect from keeping only two Gold. Tests
also cover Iconoclasm (lose 2 Food and 2 Gold), Glorious revolution, Imperium Rex,
and the ambiguous first-to-pass Books events Taoism and Romanticism.

`search_cards` ranks local candidates using words, names, number words, signed
resource amounts and a small English synonym map. It is not an embedding model
or general semantic search. Scores indicate relevance, not confidence. The agent
reads candidate records and checks target, amount, timing and conditions before
answering; unclear descriptions should yield multiple candidates or clarification.

## Rebuild and review

```text
python scripts/import-card-library.py
```

The importer reads the pinned snapshot and existing catalogue, checks the image
review source hashes, and writes the JSON/Markdown. It never marks new imports as
image-verified. To review another image, explicitly record its transcription,
review decision and source checksum first, then rebuild. If an image changes,
re-review it instead of silently updating its stored checksum. No API key or paid
AI call is required for import or offline lookup.
