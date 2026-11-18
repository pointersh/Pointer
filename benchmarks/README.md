# Benchmarks

Pointer's Rust retrieval engine against plain BM25 and grep. Measured 16 Nov
2026 on an Apple M5 laptop (24 GB). Repositories: pallets/flask 3.1.3 (commit
`22d92470`), django/django `main` (commit `f24f38c`), and Pointer itself.

## Ranking quality (Flask)

10 questions, each with known answer files (`queries.json`). The first is the
full text of a multi-file request: add a `flask config` command that must
appear in `flask --help`, be tested, and be documented (call it the *CLI
task*).

| Method | Ready | Per query | MRR | Answer file in top 5 |
|---|---|---|---|---|
| **Pointer, Rust** (BM25, symbols, file names, PageRank, tests ranked below code unless asked for) | 51 ms | 1.5 ms | **0.84** | 8/10 |
| Pointer, Rust, before tests were ranked below code | 51 ms | 1.6 ms | 0.72 | 8/10 |
| **Pointer, Rust, with semantic search (bge-small)** | 25 s embedding, once | 7 ms | **0.86** | **9/10** |
| Pointer, Rust, with semantic search (jina, before) | 4.1 min embedding | 34 ms | 0.71 | 8/10 |
| Pointer, Rust, before the ranking fix | 91 ms | 1.4 ms | 0.47 | 7/10 |
| Plain BM25, Node | 112 ms | 0.45 ms | 0.55 | 8/10 |
| Plain BM25, Python | 170 ms | 1.2 ms | 0.55 | 8/10 |
| ripgrep, query words ranked by hit count | — | 19 ms | 0.43 | 7/10 |
| git grep, same | — | 115 ms | 0.43 | 7/10 |

- **Ready:** from process start until the first query can be answered,
  including indexing (211 files, 1,376 chunks for Rust).
- **Per query:** median. Pointer's figure includes the MCP round trip over
  HTTP; the search itself takes under 1 ms.
- **MRR:** mean reciprocal rank of the first answer file; 1.0 means it always
  came first.

## Paraphrased questions (Flask)

The 10 questions above mostly name the code they want. `paraphrase.json` holds
22 more that avoid identifiers and file names ("how are values from the
environment turned into config"), with answer files checked against the Flask
source. This is where embeddings earn their keep.

| Method | MRR | Answer file in top 5 |
|---|---|---|
| **Pointer, Rust, with semantic search (bge-small)** | **0.71** | **21/22** |
| Pointer, Rust, with semantic search (jina, before) | 0.51 | 18/22 |
| **Pointer, Rust (lexical, tests ranked below code)** | **0.61** | **19/22** |
| Pointer, Rust (lexical, before) | 0.46 | 15/22 |
| Plain BM25, Node and Python | 0.45 | 15/22 |
| ripgrep | 0.28 | 13/22 |

## Semantic search: before and after

Flask, 1,275 embedded chunks, Apple M5, idle machine.

| | Before (jina-v2-base-code) | After (bge-small-en-v1.5) |
|---|---|---|
| Embedding build | 244 s | 22 s |
| Query over MCP, first time | 50–58 ms | 7 ms |
| Query over MCP, repeated | 34–41 ms | 1.5 ms (cached) |
| Query during the build | waits for the batch | never waits (3 ms median, 7.5 ms max) |
| MRR / top 5, `queries.json` | 0.71 / 8 of 10 | 0.74 / 9 of 10 (0.86 with tests ranked below code) |
| MRR / top 5, `paraphrase.json` | 0.51 / 18 of 22 | 0.62 / 21 of 22 (0.71 with tests ranked below code) |
| `vectors.bin` | 971 KB | 493 KB |
| Model download | 641 MB | 133 MB |

## Scale and memory

Same engine and baselines on three repositories. Response size is the largest
`search_codebase` answer: it stays under TrueForge's 24,000-character tool
limit at every size.

| Repository | Files · chunks | Source size | Method | Ready | Per query | Memory |
|---|---|---|---|---|---|---|
| Flask | 211 · 1,376 | ~283k tokens | **Pointer, Rust** | **51 ms** | 1.5 ms | 39 MB |
| | | | Plain BM25, Node | 120 ms | 0.4 ms | 71 MB |
| | | | Plain BM25, Python | 175 ms | 1.4 ms | 20 MB |
| Django | 5,667 · 40,177 | ~7.2M tokens | **Pointer, Rust** | 1.7–2.3 s | 14 ms | 685 MB |
| | | | Plain BM25, Node | 1.4 s | 8.8 ms | 281 MB |
| | | | Plain BM25, Python | 3.4 s | 35 ms | 150 MB |
| Pointer | 152 · 696 | ~240k tokens | **Pointer, Rust** | 52 ms | 1.0 ms | 37 MB |

- **Context compression:** each search returns ~3,000 tokens by default: 1/94 of
  Flask and 1/2,400 of Django. Neither repository fits in any model's context
  window; the agent reads only what retrieval points at.
- Memory is peak resident size. The baselines keep only term counts; Pointer
  also keeps chunk text, symbol tables, the reference graph and PageRank, which
  is what lets it explain each hit.

## Codebase

| | At the start | Now |
|---|---|---|
| TypeScript, non-blank lines | 95,327 | 9,030 |
| Runtime dependencies | 40 | 17 |
| Dev dependencies | 28 | 12 |

## Findings

- **Fusion drowned BM25.** The engine fuses BM25, symbol names and a PageRank
  prior by reciprocal rank. With equal weights, symbol and PageRank hits
  outranked strong text matches, and Rust (MRR 0.47) lost to plain BM25 (0.55).
- **CLI-task files went missing.** With the full CLI-task text, the old ranking
  never returned `tests/test_cli.py` or `docs/cli.rst`: SECRET, KEY and JSON
  pulled it toward the config files.
- **Fix** (commit `1f0fe46`):
  - a file-name signal, so the whole word "cli" points at `cli.py`,
    `test_cli.py` and `cli.rst`;
  - BM25 and file names weighted twice as much as the other signals.

  Now `cli.py` comes first for the CLI task, `test_cli.py` and `cli.rst` are 8th and
  10th of the 17 chunks returned, and all three arrive in one call.
- **Indexing was single-threaded.** On Django, 1.66 s of the 3.15 s start-up
  went to tokenizing 40,177 chunks one at a time. Tokenizing them across all
  cores cut start-up to 1.74 s and Flask from 91 ms to 51 ms, with identical
  rankings.
- **CoreML was the slow part of the old build.** ONNX Runtime registers
  CoreML on macOS by default; with jina it took 244 s. Pinning the CPU cut
  that to 84 s with identical vectors. Explicit CoreML (all units or GPU,
  MLProgram) was still running after 3 minutes, so it stays off.
- **A smaller model won on both counts.** bge-small-en-v1.5 (33M parameters)
  builds in 22 s and ranks paraphrased questions better than jina-code
  (0.55 vs 0.51 at equal weight). arctic-embed-s scored 0.50; all-MiniLM-L6
  scored 0.57 but fell to 0.51 on `queries.json`; the int8 variants of bge-small and
  bge-base ran slower than fp32 on this CPU.
- **Long instructions skip embeddings.** On the full CLI-task text, semantic
  hits pull toward the config files and push `cli.py` down to 3rd. Queries
  over 20 terms now use lexical signals only, so the CLI task ranks as before, and
  shorter questions get semantic hits at weight 3 (tried 1 to 6).
- **What did not help:** batches of 16 (slower than 4), more than 4 threads
  or two parallel sessions (the CPU is already saturated), 512-token passages
  (+0.02 MRR for 2.6× the build time), and dropping the path and symbol
  prefix from passages (−0.11 on `queries.json`).
- **Memory is the next cost to cut.** On Django the engine holds 685 MB,
  2.4× Node's BM25. Interning tokens and sharing chunk text between the parser
  and the index are the obvious fixes.
- **Grep is the floor.** Ranking by raw hit count favours long files, and
  spawning a process costs 19 to 115 ms per query.
- **Speed is not the bottleneck.** Every indexed method answers in under 2 ms;
  an agent turn waits seconds on the model. Faster tasks come from fewer model
  round trips, which better first results make possible.
- **Caveat:** 32 questions is still a small set, and the semantic weight was
  tuned on them, so treat it as provisional.

## Run it

```sh
git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git /tmp/flask
cargo build --release
node benchmarks/bench.mjs /tmp/flask target/release/pointer-retrieval
node benchmarks/bench.mjs /tmp/flask target/release/pointer-retrieval paraphrase.json
node benchmarks/placement.mjs target/release/pointer-retrieval /tmp/flask
node benchmarks/semantic.mjs target/release/pointer-retrieval /tmp/flask queries.json paraphrase.json
node benchmarks/scale.mjs target/release/pointer-retrieval /tmp/flask /tmp/django .
```

`bench.mjs` prints the table. `placement.mjs` shows where the three CLI-task files land
in Pointer's response. Set `RG` to point at a different ripgrep binary.

| File | What it is |
|---|---|
| `queries.json` | The 10 questions and their answer files |
| `paraphrase.json` | 22 paraphrased questions and their answer files |
| `bench.mjs` | Runs every method and scores it |
| `mcp.mjs` | Starts the Rust engine and queries it over MCP |
| `bm25.mjs`, `bm25.py` | Plain BM25 baselines over 40-line chunks |
| `placement.mjs` | Where the CLI task's three files land |
| `semantic.mjs` | Scores lexical and semantic search on each query file, with build time and latency |
| `scale.mjs` | Start-up, query time and peak memory across repositories |
