# prd-19 — the connection: the instrument proves its own wiring

> **Status:** proposed

## Problem

Whether data flows into rhizomorph is decided by roughly twenty preconditions —
env vars exported in the right process, a slug that resolves, a receiver that
got the right instance id — and almost none of them are verified anywhere. When
one fails, the dashboard does not say so; in the worst cases it says the
opposite. A stranger who starts the server and sees "live" has no way to learn
that nothing has ever arrived, which command would fix it, or whether their fix
worked. The people this costs are exactly the people the handover is for: cohort
members on fresh machines, without the author in the room.

## Evidence

- **Operator report (Gabe, 2026-08-07):** ran rhizomorph successfully — and the
  Claude instance he was driving it with was never instrumented. Nothing on any
  surface said so.
- `sourceStatus(undefined)` returns `'live'`
  (`packages/web/src/app/StatusBar.tsx`) — a source that has never produced an
  event wears the same calm dot as a healthy one.
- `telemetry.refused` — the receiver's own "an agent tried and was rejected"
  event — is dropped unfolded at `packages/core/src/reduce.ts` (the #62 TODO).
  No state, no UI. A misconfigured lane produces a log line nobody sees.
- `/api/meta` already serves per-collector capabilities and the enrichment rung
  (`packages/server/src/api/meta.ts`); no web component consumes either.
- The six-strategy review (docs/review/): *"the `doctor` command … is the best
  onboarding affordance in the tool and it's buried mid-README"*; *"the
  five-minute guide culminates in an empty scene … put a visible 'Explore a
  sample fleet' action in the empty state."*
- The `.workmux.yaml` SCAR (2026-08-04): a pane-env prefix silently never
  reached the agent — the same-process requirement fails invisibly.

## Success

From `/connect` alone, a stranger who has run `npm start -- <repo>` can:
see every link in the chain as VERIFIED, BROKEN, or UNPROVEN, each carrying a
fact or a reason; see an uninstrumented conductor named as BROKEN with the
exact command that fixes it; watch a row flip to VERIFIED live, without a
refresh, when the fix takes; and never mistake a fixture for live data.
**Not met while** any source with zero folded events renders "live".

## Non-goals

- **No mutation from the page.** Launch, clone, and retarget are prd-20's
  amendment; this PRD's page reads GETs and the stream, and shows commands.
- No new event types, no schema migration, no era/upcast work.
- No slug-algorithm fixes (#243) — the page *reports* a slug that resolves to
  nothing; fixing the mapping is that issue's work.
- Not a replacement for #192 (WAITING vocabulary) or #223 (staleness voice) —
  related, not superseded; both stay open.
- No adapters for other CLIs (prd-15 ruling 3 owns the adapter contract).

## Rulings

## Ruling 1 — the connect surface is a permanent `/connect` route, never an interstitial

A fifth route and a fourth nav hand, plus one quiet pointer from the empty
balcony. An interstitial that replaces the panels disappears the moment any
single event flows — which is exactly when the telemetry link is still dead.
The surface must outlive first data. (Operator-decided 2026-08-07.)

## Ruling 2 — connection facts become state, minimally

`telemetry.refused` folds into a new additive `state.refusals` slice — never a
seventh key on `TelemetryState`, whose six-key shape is a pinned law. First-flow
facts (first/last event per source, and "this session has transcript activity
but zero telemetry" — Gabe's case, derivable) are computed by a `selectConnection`
selector over already-folded records. No new event types; live, replay, and
fixtures answer identically.

## Ruling 3 — every link renders exactly one of three states

VERIFIED (a fact and its timestamp), BROKEN (a reason and the exact command),
UNPROVEN (honestly nothing yet). "Connected" means data flowed, never
"preconditions passed". The uninstrumented conductor is a first-class BROKEN
state, and a folded refusal renders BROKEN with the wrong-instance remedy from
its own payload.

## Ruling 4 — silence is never live

`sourceStatus(undefined) → 'live'` is removed. A source with no proof of flow
reads "no data yet" — muted, not an alarm; the hue laws are untouched.

## Ruling 5 — the page consumes what exists, plus one read-only doctor route

`/api/meta`'s capabilities and rung get their first web consumer. A new
`GET /api/doctor` reuses — never duplicates — the CLI doctor's check functions
for filesystem facts state cannot know (the slug dir, version drift, the lane
manifest). GET-only, no token needed under the #216 posture.

## Ruling 6 — provenance is never silent

The already-carried provenance string renders whenever the source is not live,
and the synthetic fleet becomes a visible "view a sample fleet" affordance on
the connect page. A fixture must never pass as live data — the fixture's own
doc already says so; now the UI obeys it.

## Ruling 7 — this page mutates nothing

Copy-paste commands with the live port and session id interpolated (which is
what `rhizomorph env` already does), the same-process SCAR warning verbatim
beside them, and confirmation only by watching facts change.

## Sequencing (waves, each gated as ever)

1. **Keystone:** the refusals fold + `selectConnection` (subsumes the #62 TODO).
2. Parallel, fenced apart: `/api/meta` additive connection facts · `/connect`
   route + nav plumbing · `GET /api/doctor` · fixture-badge honesty ·
   silence-is-never-live in the provenance bar.
3. The handshake page; then the sample-fleet affordance and the balcony pointer.

## Open questions

- The otel-in-ladder asymmetry: `/api/meta`'s ladder omits otel while doctor's
  includes it — two different answers to "what rung am I at". Named, not ruled;
  whoever rules it owns both files in one fence.
- Whether "waiting" sources feed the gap registry and attention strip, or stay
  ambient-only (default) until dogfooded.
- A retention cap for the refusals slice. Open, not ruled.
- Visual design of the page: the implementer's, within the hue laws.
