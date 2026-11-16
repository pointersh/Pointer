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
| **Pointer, Rust** (BM25, symbols, file names, PageRank) | 51 ms | 1.6 ms | **0.72** | 8/10 |
| Pointer, Rust, with semantic search (jina) | 101 ms + 4.1 min embedding | 34 ms | 0.71 | 9/10 |
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

- **Context compression:** each search returns at most ~4,500 tokens: 1/63 of
  Flask and 1/1,600 of Django. Neither repository fits in any model's context
  window; the agent reads only what retrieval points at.
- Memory is peak resident size. The baselines keep only term counts; Pointer
  also keeps chunk text, symbol tables, the reference graph and PageRank, which
  is what lets it explain each hit.

## Codebase

| | At the fork (pointersh/Pointer) | Now |
|---|---|---|
| TypeScript, non-blank lines | 95,327 | 9,030 |
| Runtime dependencies | 40 | 17 |
| Dev dependencies | 28 | 12 |

## Findings

- **Fusion drowned BM25.** The engine fuses BM25, symbol names and a PageRank
  prior by reciprocal rank. With equal weights, symbol and PageRank hits
  outranked strong text matches, and Rust (MRR 0.47) lost to plain BM25 (0.55).
- **CLI-task files went missing.** With the full the CLI task text, the old ranking
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
- **Semantic search barely moves ranking quality here** (MRR 0.71 vs 0.72) but
  lifts the the CLI task test and docs files from 8th and 10th to 6th and 5th. It
  costs a one-off 4.1-minute embedding build and 34 ms per query, so it stays
  off by default.
- **Memory is the next cost to cut.** On Django the engine holds 685 MB,
  2.4× Node's BM25. Interning tokens and sharing chunk text between the parser
  and the index are the obvious fixes.
- **Grep is the floor.** Ranking by raw hit count favours long files, and
  spawning a process costs 19 to 115 ms per query.
- **Speed is not the bottleneck.** Every indexed method answers in under 2 ms;
  an agent turn waits seconds on the model. Faster tasks come from fewer model
  round trips, which better first results make possible.
- **Caveat:** 10 questions is a small set, so treat the weights as provisional.
  The semantic build ran while other work loaded the CPU, so 4.1 minutes is an
  upper bound.

## Run it

```sh
git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git /tmp/flask
cargo build --release
node benchmarks/bench.mjs /tmp/flask target/release/pointer-retrieval
node benchmarks/tb.mjs target/release/pointer-retrieval /tmp/flask
node benchmarks/semantic.mjs target/release/pointer-retrieval /tmp/flask
node benchmarks/scale.mjs target/release/pointer-retrieval /tmp/flask /tmp/django .
```

`bench.mjs` prints the table. `tb.mjs` shows where the three CLI-task files land
in Pointer's response. Set `RG` to point at a different ripgrep binary.

| File | What it is |
|---|---|
| `queries.json` | The 10 questions and their answer files |
| `bench.mjs` | Runs every method and scores it |
| `mcp.mjs` | Starts the Rust engine and queries it over MCP |
| `bm25.mjs`, `bm25.py` | Plain BM25 baselines over 40-line chunks |
| `tb.mjs` | CLI-task placement check |
| `semantic.mjs` | Builds jina embeddings, then scores the same questions |
| `scale.mjs` | Start-up, query time and peak memory across repositories |
