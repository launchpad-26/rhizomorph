# @rhizomorph/core

The event contract and every pure derivation over it. Server, collectors and
web all import from here; nothing here imports from them.

```
events → reduce() → SessionState → selectors → panels / scene
```

Import everything from the package root: `import { ... } from '@rhizomorph/core'`.

## Events

One envelope, `{ id, ts, source, type, payload }`, with `ts` in epoch
milliseconds. Twelve v0 types across four sources, plus three prd1 telemetry
types across two more:

| source | types |
| --- | --- |
| `git` | `worktree.discovered` `worktree.removed` `branch.updated` `commit.landed` `worktree.dirty` |
| `tmux` | `pane.discovered` `pane.closed` `pane.activity` |
| `workmux` | `agent.status` |
| `system` | `session.started` `collector.error` `collector.disabled` |
| `sessionlog` \| `otel` | `llm.usage` `llm.cost` `tool.activity` |

```ts
const event = createEvent('commit.landed', { sha, branch, message, author, files }, { id, ts })
// source is filled in from the type — see EVENT_SOURCE_BY_TYPE
```

- `createEvent(type, payload, { id, ts })` — validated; **throws** on a bad
  payload, which is the point at the collector boundary.
- `parseEvent(value)` → `{ ok: true, event } | { ok: false, error, issues }` —
  never throws. Use this on anything off the wire.
- `EventOf<T>` / `PayloadOf<T>` for the concrete event and payload of one type.
- `createIdFactory(prefix?)` → `() => 'evt-000001'`.

`worktree.dirty` is a **snapshot**, not a delta: each event replaces that
worktree's whole uncommitted set.

### Telemetry events (prd1)

Both prd1 collectors can legitimately report the same kind of fact, so the
telemetry types accept `source: 'sessionlog' | 'otel'` and the envelope stays
the record of which one saw it. `EVENT_SOURCE_BY_TYPE` holds each type's
*primary* source; the other collector names itself in the init:

```ts
createEvent('llm.usage', payload, { id, ts })                    // → sessionlog
createEvent('llm.usage', payload, { id, ts, source: 'otel' })    // → otel
createEvent('llm.cost',  payload, { id, ts })                    // → otel
```

- `llm.usage` — `{ lane, role, model, tokens: { input, output, cacheRead,
  cacheCreation }, requestId?, durationMs?, sessionId?, worktreePath?, branch? }`.
  All four token tiers are required; a collector that cannot break out cache
  detail sends zeros and the envelope's `source` says why.
- `llm.cost` — `{ lane, role, model, costUsd, authoritative, estimateSource?, … }`.
  `authoritative: true` means the agent CLI computed the dollars (OTel's own
  `cost_usd`); an estimate must name what produced it. Sessionlog-only data
  carries no dollars rather than inventing them.
- `tool.activity` — `{ lane, tool, role?, durationMs?, … }`; `ts` is the
  envelope's.

`role` is `worker | conductor | auxiliary` and is **required** on usage and
cost: the conductor's own burn is what orchestrated setups undercount, so it is
never inferred from a lane name. Spend that cannot be attributed to a lane uses
the `UNATTRIBUTED_LANE` sentinel — visible, not dropped.

## Collector contract

```ts
interface Collector<Snapshot> {
  name: string
  initialSnapshot(): Snapshot
  poll(prev: Snapshot, ctx: CollectorContext): PollResult<Snapshot> | Promise<PollResult<Snapshot>>
}
// ctx: { repoPath, now, exec, nextId, emit(type, payload) }
// PollResult: { nextSnapshot, events }
```

Shell out only through `ctx.exec` (`Exec`, argv form, never a shell string) and
keep the parsing pure, so tests run against captured fixture text with no git,
tmux or workmux installed. Build events with `ctx.emit` — it stamps `now` and a
fresh id and validates.

## Reducer

`reduce(state, event)` and `reduceAll(events, state?)`, pure and immutable,
starting from `initialSessionState()`. The same function folds the live SSE
stream and a replayed history slice — that is why replay is free.

`SessionState` holds `session`, `mainBranch`, `worktrees`, `branches`,
`commits` + `commitOrder`, `panes`, `agents`, `collectors`, `errors`,
`telemetry`, and envelope bookkeeping (`eventCount`, `firstEventTs`,
`lastEventTs`). Removed worktrees and closed panes are marked `present: false`
rather than deleted, so history stays intact.

`state.telemetry` is `{ usage, costs, tools, lanes }` — whole records in
observation order, plus a lane attribution index (`worktreePath`, `branch`,
`sessionIds`, first/last seen; last non-null wins, because OTel carries no
cwd). No totals are accumulated there: every sum, rate and ratio is a selector,
same rule as collisions and ahead-of-main.

## Selectors

All pure, all taking `state` first. Panels should consume these and derive
nothing themselves.

- **Worktree table** — `selectWorktreeViews(state, opts?)`,
  `selectWorktreeIndex`, `selectWorktree(state, path)`. Rows arrive with
  panes, agent, dirty set, `filesTouched` and `aheadOfMain` already joined.
  Removed worktrees are excluded unless `includeRemoved: true`.
- **Collisions** — `selectCollisionMap` (every touched file),
  `selectCollisions` (contended only, worst first), `selectCollisionPairs`,
  `selectCollidingBranches`. A touch is uncommitted work in a live worktree, or
  a commit on a branch that main does not have.
- **Liveness** — `selectPaneLiveness(state, { now, flatlineMs?, idleMs? })`,
  `selectPaneLivenessIndex`, `selectFlatlinedPanes`, `selectWorktreeLiveness`.
  `now` is always injected, never read from the clock, so replay agrees with
  live. Threshold defaults to `DEFAULT_FLATLINE_MS` (5 min); statuses are
  `active | idle | flatline | closed | unknown`.
- **Branches** — `selectAheadOfMain`, `selectBranches`, `selectBranchIndex`.
  Prefers git's reported merge-base count, falling back to commits observed
  during the session (`preferReported: false` forces the derived count).
- **Commits** — `selectCommits` (newest first), `selectRecentCommits(state, n)`,
  `selectCommitsForBranch`, `commitDiffStat`.
- **Spend (prd1)** — `selectSessionSpend`, `selectLaneSpend` /
  `selectLaneSpendIndex` / `selectSpendForLane`, `selectSpendByWorktree`,
  `selectModelSpend`, `selectRoleSpend` / `selectOverheadRatio`,
  `selectSpendRate` / `selectSpendRateByLane`, `selectToolUsage` /
  `selectRecentToolActivity`, `selectTelemetryOrigins`.

Every selector accepts `{ mainBranch }` to override what "main" means.

### Reading the spend selectors honestly

All of them take an optional `SpendFilter`: `{ origins?, costs?, since?, until? }`.

- `costUsd` counts only what an `llm.cost` event carried.
  **`costIsAuthoritative` is `null`** when no cost event was counted at all —
  "we do not know", which must not render as `$0.00`. It is `false` if any
  counted dollar was an estimate.
- **`overheadRatio`** (conductor tokens ÷ worker tokens) is `null` unless *both*
  sides reported tokens. With no conductor instrumented, arithmetic would say
  `0.0` overhead — exactly the undercount prd1 exists to expose. Read
  `split.conductor.tokens.total` and `split.worker.tokens.total` to tell "no
  conductor" from "conductor idle".
- When both collectors are live they can report one request twice, once each.
  Nothing is deduplicated for you: pass `origins: ['sessionlog']` to pick the
  token authority (it is the one with cache-tier detail).
- `selectSpendRate(state, { now, windowMs? })` — `now` is injected, never read
  from the clock, and records newer than `now` are excluded, so a scrubbed
  replay reads the rate that moment actually had. Zero-width windows report
  totals with all rates at `0` rather than dividing.

## JSONL

```ts
eventsToJsonl(events)            // newline-terminated document
eventToLine(event)               // one line, no newline
lineToEvent(line, lineNumber?)   // { ok: true, event } | { ok: false, kind, error, line, lineNumber }
parseJsonl(text)                 // { events, errors } — blank lines skipped
```

Reading never throws: a truncated final line is normal when tailing a live
session, so it comes back as an error value to log and step over.

## Test fixtures

```ts
const f = createEventFactory({ startTs, stepMs, idPrefix })
f.worktreeDiscovered({ path, branch, isMain: false })   // partial payload, rest defaulted
f.commitLanded({ sha: 'c1' }, { ts: 1234 })             // pin the clock when it matters
f.all()                                                  // everything it made, in order

f.llmUsage({ lane: '33-core', role: 'conductor' })       // prd1 telemetry
f.llmCost({ lane: '33-core' }, { source: 'sessionlog' }) // pick the collector

fixtureSession()   // a scripted swarm: 4 worktrees, 3 panes, 3 commits,
                   // 2 file collisions, 1 pane silent since t+1m
FIXTURE_NOW        // the `now` to pass to liveness selectors for that session
makeEvent(type, payload, { id?, ts? })  // a validated one-off

fixtureTelemetrySession()  // fixtureSession() + the money layer: 3 worker
                           // lanes, a conductor that outspends all of them, an
                           // auxiliary haiku call, one estimated cost
```

`fixtureTelemetrySession()` is a separate log on purpose — `fixtureSession()` is
frozen, so every v0 panel test keeps reading exactly what it read before. Its
token proportions and `cost_usd` figures are the real ones captured in
`research/2026-07-30-telemetry-capture-routes.md`.

Fixtures go through the schemas, so a stale fixture fails loudly instead of
propagating a shape that no collector will ever emit.
