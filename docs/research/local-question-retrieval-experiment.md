# Local question retrieval experiment

Implemented and evaluated locally on 2026-10-30. The experiment is opt-in through
`NATIONS_QUESTION_RETRIEVAL=hybrid`; no Railway deployment or production configuration
change was made. See [setup and behavior](../question.md#optional-local-hybrid-retrieval-experiment).

## Implementation

- A local CPU embedding worker uses pinned, quantized BGE-small-en-v1.5, with
  384-dimensional normalized vectors. Runtime never downloads models or sends
  queries to an embedding API. Docker prepares the model during its build.
- Lezer parses the Python snapshot into class-level regions, functions, methods,
  and nested definitions. Embedding text includes enclosing signatures and split
  identifier words. Long passages fit the actual tokenizer window; original source
  IDs, definition/passage lines, commit, and evidence metadata are preserved.
- Rulebook pages, FAQ, supplemental amendments, owner implementation notes and card
  effects share the index with their original provenance. No generated summaries
  or resolved call graph are included.
- BM25 and cosine-search rankings are combined with reciprocal rank fusion. The
  original source/card search contributes reserved leading matches, preserving
  exact symbols and the existing specialized card ranking. Source reads still
  establish evidence; similarity scores do not establish correctness.
- Content-addressed vectors persist on the existing service volume. Changed sources
  rebuild a complete replacement, reusing unchanged embeddings and refreshing line
  numbers and metadata. A stale index never supplies results for a new snapshot.
  Model/index/worker failures fall back to the original search.

## Local measurements

Windows, Node 24.16.0, CPU inference limited to one ONNX thread. These are desktop
measurements, not Railway measurements. The bundled Tabony revision was
`9c344205b1802c9583d20c749b89a4cfa52516f7`.

The [18 smoke cases](../../tests/fixtures/question-retrieval.json) include code
symbols, natural-language implementation questions, rulebook questions, card effects,
and two previously logged staging queries already covered by card-library regression
tests. Those last two require all three known relevant events, not just one match.
Code cases require the relevant function or source line, not merely the correct file.

| Retrieval | Evidence in top 5 | Evidence within returned results | Median search | p95 search |
| --- | ---: | ---: | ---: | ---: |
| Existing literal/card search | 8/18 | 8/18 | 1.98 ms | 10.49 ms |
| BM25 alone | 12/18 | 14/18 | 2.32 ms | 4.94 ms |
| Vectors alone | 13/18 | 16/18 | 20.74 ms | 25.22 ms |
| Actual hybrid wrapper | 17/18 | 18/18 | 22.62 ms | 25.92 ms |

Source searches return at most 14 results; the hybrid card tool retains its existing
eight-result cap. Each method embeds its query separately; hybrid timing does not
reuse the vector-only query embedding. Query text/vectors are not persisted in the
vector cache. The exact timings are descriptive samples, not performance thresholds.

There are 877 source documents, 2,928 passages and 2,899 unique enriched texts.
Numeric vector storage is approximately 4.5 MB. A fresh build with sorted embedding
batches took 169.3 seconds; a cached restart took 2.425 seconds and generated zero
new embeddings. The cached benchmark process sampled approximately 365 MiB RSS
after preparation. This includes Node, source/index data and inference runtime;
it is neither isolated model memory nor a measurement of the live bot's additional
memory or peak consumption. Staging must establish those figures.

The remaining top-five miss was the Polish-Lithuanian Commonwealth advisor-filtering
function, which hybrid search returned sixth. It retrieved the containing class and
other related methods earlier; the investigator still needs to follow the relevant
definition. Pure vector search also failed to return the complete expected groups
for the two existing staging event queries. Preserving specialized literal/card
retrieval is useful even when semantic retrieval improves other questions.

## Interpretation and reproduction

These are curated smoke cases assembled with knowledge of the corpus, not a held-out
evaluation. All methods receive the same English query. The current question agent
can already reformulate a user's question into several literal searches, so the
baseline's misses here are **not** a measurement of existing answer failures.
Final answer correctness, model rounds, token cost, and total question latency have
not been evaluated against a live answer model. Search itself became slower; fewer
investigation rounds could offset that, but this experiment does not establish it.

```powershell
npm run question:model
npm run question:evaluate
```

The model command is the only step that needs a model download. Evaluation uses
bundled sources and the local model, without Discord connections or paid API calls.
Detailed results are written to ignored `.data/question-retrieval-evaluation/evaluation.json`.
The recorded final run used `-- --directory=.data/question-retrieval-final`.

Normal tests cover syntax-aware extraction, scoped ranking, evidence metadata,
offline-model fallback, opt-in lifecycle, and asynchronous agent tools. An additional
offline real-model test exercises cache reuse/corruption, changed source text,
shifted line numbers, main-thread responsiveness, reserved literal matches, and
fallback after worker loss. Set `NATIONS_VECTOR_TEST_MODEL_DIR` to the prepared model
directory to include it. Existing CI runtime checks cover discovery, subscriptions,
and standings. Docker was unavailable locally, so a container build and Railway
resource/answer comparisons remain deployment validation work.
