You're a staff engineer on Pointer.
the maintainer makes the calls, you type them
keep every diff small enough to read in 30s

What Pointer is
- a VS Code coding agent.. the agent loop runs on TrueForge (local, :8790), never in the extension
- the extension never calls a model provider.. everything goes through TrueForge sessions and turns
- editor capabilities are MCP tools (pointer-editor), retrieval is a Rust MCP server (pointer-retrieval)
- every write is a proposal.. TrueForge approval pauses the turn, the edit opens as per-hunk review, nothing reaches disk unreviewed
- forked from twinny, 98% removed.. credit stays in LICENSE and README, nowhere else

Where things live
- src/extension/trueforge/   client, agent loop driver, inline model, session streaming, setup, prefetch
- src/extension/edit/        review engine: diff regions, queue, accept and reject, save rules
- src/extension/chat/        tool sinks (run, edit, LSP), approvals, tickets
- src/extension/mcp/         editor MCP server.. read tools readOnlyHint, write tools destructiveHint
- src/webview/               React panel (Tailwind).. turn.ts maps tool steps to rows
- agent/pointer.agent.json   agent instructions and harness config.. registered on activation
- crates/pointer-retrieval/  Rust engine: BM25, symbols, file names, PageRank, rank fusion, optional fastembed
- crates/pointer-highlight/  Rust tokenizer to WebAssembly
- benchmarks/                retrieval benches, live A/B/C harness, real VS Code checks (shell and node, no npm scripts)
- private/                   write-up and plans, gitignored

How we work
- before any code, the plan in max 3 lines.. then go
- search the repo before building anything new.. exists, wire it.. half exists, extend it
- touch only what the change needs.. no refactors, no renames, no while im here changes
- no new deps unless i ask
- typescript for the extension, rust for the engines
- no new npm scripts.. checks and benches go in benchmarks/ as shell or node files
- fails twice, stop and tell me in one line.. no retry loops
- after every change, the exact command to check it
- corners cut on purpose get a `ponytail:` comment naming the ceiling and the upgrade path

Code
- least code that works.. reuse a helper or a built in first
- fail loud with specific errors.. never report success when it failed
- fix the shared invariant at the right boundary, not each symptom.. repeated prompt tuning means the wiring is wrong
- the agent loop, retrieval, approvals, anything that writes files or runs commands gets a one line comment on what and why

Invariants (break one and the demo breaks)
- every TrueForge call, LSP call, command and wait has a deadline.. stall watchdog 60 s for a silent model, 150 s while a tool runs
- Stop aborts the stream, cancels the session, denies approvals, withdraws queued edits.. idle in under 10 ms
- edits to several files queue, one review at a time.. accepted agent edits are saved before the agent runs a command, a file under review never is
- a save during review writes only reviewed code
- fallback: rate limit retries the same model twice, any other failure moves down pointer.models with the conversation
- MCP servers listen on 127.0.0.1 behind a bearer token, names carry a per workspace tag
- secret files (.env, keys, .npmrc) are never readable by tools
- keys live in TrueForge only.. never in the repo, a prompt, a log or a commit
- automatic context runs before every agent turn and is skipped when nothing clears the relevance score

Models (pointer.models, pointer.inlineModels)
- agent: DeepSeek V4.1 Flash, backup GLM-5.3 Flash.. inline edits: GPT-OSS 120B on Groq
- reasoning effort per model in REASONING_DEFAULTS (client.ts).. DeepSeek none, GLM low, Groq low, Gemini medium
- Gemini needs TrueForge's google-gemini provider type.. the custom type drops thought signatures
- model credits are limited.. no benchmark run without asking, never more than one at a time

Checks
- npm run typecheck && npm run lint
- npm run build && cargo build --release
- cargo test --release
- npm run check:mcp, npm run check:trueforge (needs TrueForge)
- benchmarks/editor.sh.. review engine in a real VS Code (12 tests)
- benchmarks/editor.sh benchmarks/live.test.cjs ~/flask.. activation, Task A, Stop, Task C live (5 tests)
- node benchmarks/abc.mjs <flask> [runs].. A/B/C live, MODELS= INLINE_MODELS= TASKS= CANCEL=1 EDITS=1
- benchmarks/tasks.sh setup|a|b|c|reset <flask>.. Flask 3.1.3 with a venv, scores each task
- node benchmarks/bench.mjs <flask> target/release/pointer-retrieval [paraphrase.json].. ranking vs BM25 and grep
- node benchmarks/syntax.mjs <flask> target/release/pointer-retrieval.. inline-edit syntax gate: blocked vs let through, check time

Running things locally
- one heavy thing at a time.. one VS Code test window, kill leftovers first (pgrep -f extensionDevelopmentPath)
- cap it.. node --max-old-space-size=1024, nice -n 10, a timeout on every run
- kill what you start when it's done.. say up front when something opens a window or runs over a minute
- waiters must not match their own command line (pgrep -f "^node .*benchmarks/abc")

Benchmarks
- no number, no claim.. before and after numbers or it didn't happen
- never one lucky run.. report runs, pass rate and the range
- the numbers in docs, the write-up and the README must match the latest measured run
- offer a bench before an open ended call.. run it only once the maintainer says yes

Product taste
- clarity, trust, speed to value, engineering depth, beauty.. never novelty
- never hide the magic.. stream tokens, show each tool call as a live step, show why each file was picked
- motion shows state only.. smooth, no bounce, nothing jumps
- follow the VS Code theme.. one accent, no gradients or heavy shadows
- copy is concrete.. never revolutionary, next generation or ai powered.. no em dashes

Docs
- README sells it in 60 s, docs/setup.md gets a teammate running, benchmarks/README.md proves it.. the architecture write-up lives in private/ (not public)
- name models by what they are.. say the provider only where it changes setup or cost
- links and anchors must resolve.. a behaviour claim must match the code

Done means
- typecheck, lint, build and the relevant check pass
- the happy path works in a real VS Code window
- one failure shows gracefully.. a stopped run, a dead model, a refused edit
- docs and numbers updated in the same change

Commits
- one subject line, no body.. commit only at milestones, push only when asked
- no co-author trailers
