# Architecture — The Observatory

> **Living document.** Blessed by Lachlan 2026-07-30 before any code. Real
> decisions made during the build get appended, not rewritten.

## Platform

- Node 22, TypeScript strict mode.
- npm-workspaces monorepo:
  - `packages/core` — event schema + pure logic (reducer, selectors)
  - `packages/server` — collectors + API + CLI
  - `packages/web` — Vite + React + Tailwind 4 + react-three-fiber
- Vitest everywhere.
- Exact versions are pinned at scaffold time (issue #1) and recorded here by
  the scaffold worker, not remembered.

## The one structural decision that matters: event-sourced core

Every fact is an event in one append-only log; every consumer reads the same
stream. `packages/core` owns the event envelope and types — zod schemas,
runtime-validated at the collector boundary, inferred TS types everywhere
else:

```ts
{ id, ts, source: 'git' | 'tmux' | 'workmux' | 'system', type, payload }
```

v0 event types:

- **git:** `worktree.discovered/removed` · `branch.updated` (head moved) ·
  `commit.landed` (message, author, diffstat, files) · `worktree.dirty`
  (uncommitted changed-file set — what makes collision warnings *early*,
  before commits exist)
- **tmux:** `pane.discovered/closed` · `pane.activity` (content-hash delta
  per poll)
- **workmux:** `agent.status` (working/waiting/done)
- **system:** `session.started` · `collector.error/disabled`

`core` also owns the **`Collector` interface**, so collectors and the server
loop build against the same contract without touching each other's files.

## Collectors emit raw facts only

Flatline, collisions, "ahead of main" — all *derived* downstream by pure
selectors in `core`, shared by server and web. Collectors stay dumb and
testable; the interesting logic lives where the dense unit tests are; the
same selectors serve live view and replay identically.

## Collector shape

Each collector is `poll(prevSnapshot) → { nextSnapshot, events[] }` — pure
logic over the *output text* of shell commands (`git worktree list
--porcelain`, `git diff --name-status`, `tmux capture-pane`, `workmux
status`), with a thin exec wrapper. Unit tests run the pure part against
captured fixture outputs — no git/tmux needed to test. Poll every 2s; emit
only diffs (snapshot comparison, no tick spam). A missing binary (no workmux,
no tmux) → one `collector.disabled` event; everything else keeps working.

## The log lives outside the watched repo

`~/.local/share/observatory/<repo-slug>/session-<ts>.jsonl`. The read-only
promise means we don't even add a gitignored directory to the target repo.

## Server

Fastify:

- `GET /api/stream` — SSE: replays the session so far from offset, then
  live-tails.
- `GET /api/sessions`, `GET /api/sessions/:id/events` — history for replay.
- `GET /api/meta` — repo name, session info.
- Serves the built web app statically — one origin, no CORS.

CLI entry `observatory [path]` boots collectors + server, prints the URL.

## Web

One SSE hook feeds one reducer (imported from `core`) into React context —
no state library (one tree, one store). **Live and replay are the same
reducer**: live folds the stream as it arrives; replay folds a history slice
under a scrubber clock. That one property is why replay is free.

Panels are sibling directories (`panels/worktrees`, `panels/collisions`,
`panels/ticker`, …), each consuming selectors only. The shell pre-creates
lazy-loaded slots and stub directories for every panel, so panel workers only
ever edit their own directory — that is the file-disjointness that lets three
agents build three panels simultaneously.

## The scene

react-three-fiber, lazy-loaded behind an error boundary, consuming the same
selectors — no bespoke data path. If it breaks, the panel grid stands alone;
the demo survives.

## Testing

Mass on core selectors/reducers and collector parsers (fixtures captured
from real command output). Light render tests on panels. The scene is
verified by eyes, not units — said honestly. Merge gate: `npm test` +
`npm run typecheck` green, enforced mechanically by a workmux `pre_merge`
hook.

## Decisions log

- 2026-07-30 — zod at the collector boundary: runtime validation costs a
  dependency but makes bad parser output loud instead of silent. (Blessed.)
- 2026-07-30 — session logs outside the repo: purist read-only, slightly
  less discoverable. (Blessed.)
- 2026-07-30 — Tailwind 4 for panels: daily fluency, faster worker output,
  one more scaffold dep. (Blessed.)
- 2026-07-30 — Collector loading must be static, not dynamic: a variable
  dynamic import (`../collectors/${slug}/index.js`) can't be statically
  analysed by Vite/Rollup, so every collector silently failed to load while
  the server booted happily and emitted only `session.started`. Collectors
  are now imported explicitly. (issue #14)
- 2026-07-30 — SSE frames are named, and the client must subscribe by name:
  the server writes `event: <type>`, but a client using only `onmessage`
  receives every frame and drops it — `onmessage` fires only for unnamed
  frames. Both packages were green in isolation because the web test double
  called `onmessage` directly instead of imitating the real wire format; test
  doubles must match the real protocol, not the convenient one. (issue #17)
- 2026-07-30 — Panels must distinguish "connected but idle" from "not
  connected": otherwise the dashboard's own empty state is indistinguishable
  from the failure it exists to reveal. (issue #18)
- 2026-07-30 — Source files must be plain UTF-8: one stray NUL byte made
  `selectors/collisions.ts` binary to git — undiffable and unmergeable —
  while it still compiled and passed tests.
- 2026-07-30 — Fences must cover every file a change can orphan: core
  removed the scaffold's placeholder export as part of landing the real
  event schema, but the server's and web's still-scaffolded entry points
  imported it and sat outside core's fence, so the root gate would have gone
  red for every branch at once. The export was kept alive, deprecated, until
  the files that depended on it were replaced by their own issues.
- 2026-07-30 — prd1: `role` (`worker | conductor | auxiliary`,
  `agentRoleSchema` in `packages/core/src/events/telemetry.ts`) is attributed
  at the collector boundary, never guessed from a lane name. A conductor
  commonsensically doesn't run inside a workmux-managed worktree, so nothing
  about its lane name would ever say "conductor" — the only sources of truth
  are the OTel dispatch's own `role=<role>` resource attribute and the
  hardcoded `role: conductor` the `sessionlog` collector applies to every
  session under `--extra-sessions`.
- 2026-07-30 — prd1: the orchestration overhead ratio (conductor tokens ÷
  worker tokens) is a first-class selector (`selectRoleSpend` /
  `selectOverheadRatio`, `packages/core/src/selectors/spend.ts`), not a
  downstream derivation, because orchestrated setups undercount by omitting
  the conductor's own spend — plausibly the largest single consumer in this
  build day. `overhead()` returns `null`, never `0`, unless both conductor
  and worker tokens are measured and non-zero, so a conductor that hasn't
  sent telemetry yet reads as "unknown," not "free."
- 2026-07-30 — prd1: two telemetry collectors by design, not redundancy.
  `otel` (`packages/server/src/collectors/otel`) is the sole source of
  authoritative `cost_usd` — real dollars, no pricing table; the one unrun
  claim from `research/2026-07-30-telemetry-capture-routes.md`
  (`OTEL_RESOURCE_ATTRIBUTES` lane tagging) was proven live in issue #36.
  `sessionlog` tails `~/.claude/projects/*/*.jsonl` for free structural
  attribution and per-message cache-tier token depth OTel's own metrics never
  break out, but is documented "No dollars" (`packages/core/src/events/
  telemetry.ts`) rather than estimate them from a pricing table. Either
  degrades to `collector.disabled` alone; together they cross-validate.
- 2026-07-30 — prd1: `user.email` rides along on Claude Code's own OTel
  resource attributes by default (per the research spike), and there is no
  explicit redaction step that strips it. Instead the otel collector's event
  builders (`buildUsageEvent` / `buildCostEvent`,
  `packages/server/src/collectors/otel/parse-metrics.ts`) only read a fixed
  allowlist of attributes by name off the wire payload, so `user.email` is
  structurally never copied into a stored event — allowlist-by-construction,
  not scrub-after-the-fact. Verified by test, not merely assumed from the
  code's shape (`parse-metrics.test.ts`: "never copies user.email … into the
  stored payload").
- 2026-07-30 — prd1 (issue #47): **design for the correctly-configured case;
  surface incomplete configuration as a gap, never as a second-class metric.**
  The spend ticker previously rendered `OVERHEAD 0.14×` from the token-based
  `overheadRatio` in `selectRoleSpend` (`packages/core/src/selectors/
  spend.ts`, unchanged by this issue and still correct for what it measures)
  while the actual conductor had sent zero `llm.cost` events — the ratio came
  from `sessionlog --extra-sessions` tagging an unrelated probe session
  `role: conductor`, tokens with no dollars attached. That number was worse
  than absent: it looked like a real measurement of orchestration overhead
  and was not one. `SpendPanel` (`packages/web/src/panels/spend/`) now
  computes its own cost-only overhead (`selectCostOverhead`/
  `formatCostOverhead`, `packages/web/src/panels/spend/format.ts`) straight
  from `RoleSpend.costUsd`/`costEventCount` — fields `selectRoleSpend` already
  exposed — and renders `conductor not instrumented — see docs/telemetry.md`
  whenever `conductor.costEventCount === 0`, regardless of what its tokens
  say. **Rejected alternative:** keeping the token-based ratio alive as a
  fallback so historical, un-instrumented sessions (this project's own build
  day) would still produce a number. Rejected because that fallback fits one
  accident of this project's own history — a conductor that was, in fact,
  never wired for cost — onto every future user's un-instrumented setup,
  training them to read a token ratio as a dollar figure. Cost is the one
  metric; provenance (`authoritative` vs. estimated) is shown on it; a gap in
  it is shown as a gap.

## Platform — pinned versions (issue #1, 2026-07-30)

| Package | Version |
| --- | --- |
| node (engine) | 22 |
| typescript | 7.0.2 |
| vitest | 4.1.10 |
| zod | 4.4.3 |
| fastify | 5.10.0 |
| vite | 8.1.5 |
| @vitejs/plugin-react | 6.0.4 |
| react | 19.2.8 |
| react-dom | 19.2.8 |
| @types/react | 19.2.17 |
| @types/react-dom | 19.2.3 |
| tailwindcss | 4.3.3 |
| @tailwindcss/vite | 4.3.3 |
| @react-three/fiber | 9.6.1 |
| @react-three/drei | 10.7.7 |
| three | 0.185.1 |
| @types/three | 0.185.1 |
| jsdom | 30.0.1 |
| @testing-library/react | 16.3.2 |
| @testing-library/jest-dom | 7.0.0 |
| tsx | 4.23.1 |
| @types/node | 22.20.1 |

- 2026-07-31 — **prd1 (the money layer) complete.** Two native collectors
  shipped: `sessionlog` (depth — per-message tokens by tier, tool timeline,
  lane attribution from cwd/branch) and `otel` (authority — an OTLP/HTTP
  receiver yielding `costUsd` with `authoritative: true`). Spend is keyed by
  **branch**, so a lane's cost survives the worktree's removal. `role`
  (worker | conductor | auxiliary) is first-class; the overhead ratio is
  defined on cost. `--extra-sessions <dir>[:<lane>]` is **dir-first** — the
  session-log directory is the input, no slug inference, no platform
  assumption — which is what makes a conductor on another OS countable.
  Verified live end to end: 4,989 `role: conductor` events from a Windows-side
  conductor's log dir, per-lane dollars in the ticker and worktree table, the
  per-branch ledger, and replay reporting `$0.02 as of scrub time` through the
  same reducer as the live view.

