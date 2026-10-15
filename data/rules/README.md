# Nations rulebooks for local questions

- [Base game rulebook](base.md): 24 PDF pages; supplied English PDF identified by
  filename date 2014-03-17.
- [Dynasties rulebook](dynasties.md): 4 PDF pages; supplied English PDF identified
  by filename date 2015-08-24.
- [Manifest](manifest.json): source PDF SHA-256, edition identifier, Markdown hash,
  page/line boundaries and headings.

The English source is preserved rather than translated or paraphrased into new
rules. These are the user's supplied editions, not a claim about the newest
edition online. The original files remain under `Reference/`; the Railway image
only needs the Markdown and manifest.

## Parsing and verification

Rebuild using the bundled Python (or Python with `pdfplumber` installed):

```text
python scripts/import-rulebooks.py
```

The importer deduplicates overlapping glyphs, selects original-size body text and
headings, and reads explicit page/column/callout regions in order. This avoids
doubled letters and interleaved columns. Known ligature spacing is repaired and
typeset line wrapping is joined. Illustrations contain miniature, rotated and
sometimes clipped/hidden text; these are excluded rather than promoted into rules.
Diagnostics in ignored `work/rulebooks/` count extracted/excluded glyphs and save
the selected raw text by page. They are not runtime dependencies.

All 28 rendered source pages were inspected for layout. Important resource icons
are transcribed as bracketed terms where needed; visual explanations are marked
`Editor note`, separate from publisher prose. This is **not** a complete
word-for-word independent proofreading or a transcription of all miniature card
statistics. Any remaining diagram-dependent ambiguity must be resolved from the
source PDF, not guessed. Keep typos in the source distinct from new rules.

## Bot access

`loadQuestionRulebooks()` verifies the Markdown checksums, splits by the manifest's
PDF page boundaries, and adds immutable local IDs such as `rules/base/page-10`
and `rules/dynasties/page-3`. The same `search_sources` and `read_source` tools read
these pages without network requests. Each read returns title, edition, PDF page,
review status and source checksum. Citations use the printed/PDF page rather than
the generated Markdown line number alone.

The daily GitHub update applies only to implementation code. These supplied
rulebooks change only through a deliberate import of another source PDF.
