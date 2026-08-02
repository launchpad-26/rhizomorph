# prd2 audit — what three code audits found

> Researched 2026-07-31 for **one decision: what must change before a stranger
> can trust this app's numbers or run it at all.** Every claim below is
> `[Verified]` against the code at commit `099fe68` unless marked otherwise.
> File:line references are the point of this note — they are what a fresh
> session needs in order to act without re-deriving the audit.

## Why this note exists

Lachlan asked four questions (do counts refresh per session? are role names safe
across machines/setups/instances? are workers and threads costed separately from
the conductor? could a stranger on a fresh machine run this?). Three parallel
code audits answered all four with "no". `docs/prd2.md` carries the rulings; this
note carries the evidence.

## A. The numbers do not mean what they say

- **Backlog ingestion.** `packages/server/src/collectors/sessionlog/collector.ts:249`
  — an unseen file starts at `offset: 0`, so the first poll reads every line ever
  written. There is no "seek to EOF on first sight" branch. Contrast
  `packages/server/src/collectors/git/git-collector.ts:149`, which only loads
  commits when a previous snapshot exists — git starts from *now*, sessionlog
  starts from the beginning of time. **That asymmetry is the bug shape.**
- **Wrong timestamps.** `packages/server/src/server/poll-loop.ts:45` stamps every
  emitted event with the poll wall-clock (`tickNow`), not the log line's own
  time. `parse-session-line.ts:78-91` does not even extract the line's
  `timestamp`. Consequence: week-old activity lands inside the 5-minute rate
  window (`selectors/spend.ts:425,451`), so `$/hr` spikes on boot, and replay
  compresses history into a single instant.
- **Restart duplication.** A new session file is created per run
  (`cli/index.ts:75-87`); the re-read backlog is written into it
  (`server/recorder.ts:28`). N restarts produce N files each containing the same
  history. Collector byte-offsets are process-local (`poll-loop.ts:35`) and never
  persisted.
- **No dedup.** `core/src/reduce.ts:354-357` appends unconditionally; cross-origin
  dedup by `requestId` is impossible today because OTel usage sets
  `requestId: null` (`collectors/otel/parse-metrics.ts:142`).

## B. Identity collides silently

- **No namespacing anywhere.** `lane` is a bare string used directly as a map key
  (`core/src/state.ts:201`, `reduce.ts:427`), schema `nonEmptyString`
  (`core/src/events/telemetry.ts:71`). The only uniqueness treatment in the repo
  is for *log file paths* (`log/paths.ts:14-19`, sha1 of the abs path "so two
  repos named the same don't collide") — never applied to identity.
- **The conductor is booked as a worker.** `collectors/sessionlog/collector.ts:126`
  hard-codes `role: 'worker'` for every entry from `git worktree list`, **which
  includes the main working tree**. A conductor driving the repo root is worker
  spend unless `--extra-sessions` is remembered. The same agent can be `worker`
  via sessionlog and `conductor` via OTel in one log.
- **Magic strings and positional names.** Role is inferred from the literal lane
  string `'conductor'` (`collectors/otel/attribution.ts:49`); extra-session
  conductors are named by flag order (`collector.ts:179`), so reordering flags
  renames lanes across restarts.
- **Open receiver.** `api/otel.ts:29-40` accepts any POST — no auth, no instance
  or repo check — and `.workmux.yaml:22` hard-codes the default port, so a second
  repo on the same box exports into whichever Rhizomorph is listening.
- **Fallback lane churn.** An untagged agent falls back to `shortHash(session.id)`
  (`attribution.ts:28`), minting a new lane on every restart.

## C. Threads invisible; branch cost structurally impossible

- `query_source` (main | subagent | auxiliary) is read at
  `parse-metrics.ts:122,173` but only to pick a role; both `main` and `subagent`
  fall through to `worker` (`attribution.ts:50-51`) and the value is never stored
  on the payload. Subagent spend is unrecoverable downstream.
- `isSidechain` **is present** in real captured session JSONL (see
  `collectors/sessionlog/fixtures/conductor-root.jsonl:1`) and is never parsed;
  `AssistantLineFacts` (`parse-session-line.ts:16-30`) has no such field.
- OTel events carry `branch: null` and `worktreePath: null`
  (`parse-metrics.ts:145-146,186-188`) and sessionlog never emits `llm.cost`
  (`collector.ts:266,280`). Therefore `selectSpendByBranch` /
  `selectSpendByWorktree` (`selectors/spend.ts:223,184`) have **tokens but
  structurally zero dollars** — the ledger's COST column cannot show money.
- There is **no lane × role selector**: role and lane are both per-record but
  never keyed jointly, so "conductor spend within lane X" is unaskable.

## D. A stranger cannot run it — `[Ran]`

- `npx rhizomorph` is the only documented command (`README.md:19`,
  `docs/demo.md:12`). The root package is `private: true`, `version: 0.0.0`, with
  no `bin`; `package-lock.json:5043-5053` predates the `bin` added to
  `packages/server`. `[Ran]` `npx --no-install rhizomorph --help` →
  *"could not determine executable to run"*; `node_modules/.bin/rhizomorph` absent.
- `[Ran]` `npm view rhizomorph` → a real, unrelated package
  ("Beautiful UI for showing tasks running on the command line"). **A stranger
  following our README installs someone else's code.**
- What actually works, documented nowhere: `node packages/server/bin/rhizomorph.mjs --help`,
  `npm exec --workspace packages/server -- rhizomorph --help`.
- No clone URL anywhere in the repo; no `engines` despite README claiming Node 22;
  no LICENSE; no CI; no root `build`/`start` script; no doctor/status command.
- Missing web dist → the static route is silently skipped
  (`server/build-app.ts:12-14`) and the browser gets a bare JSON 404.
- A non-git directory emits `collector.error` **every 2 seconds forever**
  (`git-collector.ts:32-41` never latches, unlike every other collector).
- `EADDRINUSE` is an unhandled rejection (`cli/index.ts:112`, `bin/rhizomorph.mjs:8`).
- Status bar covers 3 of 5 collectors (`app/StatusBar.tsx:7-9`) — sessionlog and
  otel health are invisible, and sessionlog is the most likely thing to be broken.
- Personal data ships in the UI: `packages/web/src/scene/fixtures.ts:39,55`
  hardcodes `/home/operator/rhizomorph` and real names into the demo
  constellation rendered whenever the stream is empty.

## Verdict

prd2 (`docs/prd2.md`) exists to fix exactly these, in the order D → A → B → C:
the stranger cannot test anything until the app runs, and the numbers cannot be
trusted until they are session-scoped and correctly timestamped.

## Open questions

- Is `selectOverheadRatio` on tokens or cost? The audit read
  `selectors/spend.ts:404-420` as **tokens**, while issue #47's commit message
  claims cost. Resolve before relying on the figure.
- A published name: `rhizomorph` is taken on npm. Scoped name, or a new one?
  **Lachlan's call, not the fleet's.**
- Cross-machine conductors: is a shared receiver ever wanted, or is one
  Rhizomorph per machine the honest model?
