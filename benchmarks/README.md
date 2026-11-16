# Retrieval benchmark

Pointer's Rust retrieval engine against plain BM25 and grep, on pallets/flask
3.1.3 (commit `22d92470`). Measured 16 Nov 2026 on an Apple Silicon laptop.

## Results

10 questions, each with known answer files (`queries.json`). The first is the
full text of a multi-file request: add a `flask config` command that must
appear in `flask --help`, be tested, and be documented (call it the *CLI
task*).

| Method | Ready | Per query | MRR | Answer file in top 5 |
|---|---|---|---|---|
| **Pointer, Rust** (BM25, symbols, file names, PageRank) | 91 ms | 1.6 ms | **0.72** | 8/10 |
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
- **Grep is the floor.** Ranking by raw hit count favours long files, and
  spawning a process costs 19 to 115 ms per query.
- **Speed is not the bottleneck.** Every indexed method answers in under 2 ms;
  an agent turn waits seconds on the model. Faster tasks come from fewer model
  round trips, which better first results make possible.
- **Caveat:** 10 questions is a small set, so treat the weights as provisional.
  Semantic search (jina, `--semantic`) is not measured here: its cold build
  takes about 5 minutes.

## Run it

```sh
git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git /tmp/flask
cargo build --release
node benchmarks/bench.mjs /tmp/flask target/release/pointer-retrieval
node benchmarks/tb.mjs target/release/pointer-retrieval /tmp/flask
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
