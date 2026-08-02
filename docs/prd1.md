# PRD 1 — The Money Layer

> **Status:** blessed by Lachlan, 2026-07-30. Capture routes decided by live
> evidence: `research/2026-07-30-telemetry-capture-routes.md`.

## One-liner

The Rhizomorph learns what the swarm costs: live token and dollar telemetry
per lane, taken from the agents' own native signals, rendered as instruments
and replayable like everything else.

## Why this first

Efficiency is the point of agentic systems — time and cost against output. A
swarm that ships beautifully while silently burning $60/hour is a broken
pipeline, and today that burn is invisible. This was also the strongest point
of agreement in the 2026-07-30 JV call, and it gives prd2's visualization
design study real metrics to encode.

**The conductor counts.** Orchestrated setups systematically undercount by
omitting the orchestrator's own spend — in our own build day the conductor was
plausibly the largest single consumer. prd1 treats `role`
(worker | conductor | auxiliary) as a first-class dimension and makes the
**orchestration overhead ratio** (conductor tokens ÷ worker tokens) a headline
metric: the empirical price of the brain/hands principle.

## The two collectors

Both implement the existing `Collector` contract; each degrades to
`collector.disabled` alone; together they cross-validate.

1. **`sessionlog` — depth.** Tails `~/.claude/projects/<watched worktrees>/*.jsonl`:
   per-message tokens by cache tier, model, request duration, tool-call
   timeline. Attribution is structural (`cwd`/`gitBranch` on every line).
   Zero worker configuration. Fixtures come from the build day's real
   session logs. Foreign session dirs (e.g. a conductor on another
   filesystem) via an opt-in `--extra-sessions` flag — the zero-config
   promise stays intact.
2. **`otel` — authority.** A minimal OTLP/HTTP receiver inside the existing
   Fastify server. Lanes are dispatched with the telemetry env vars plus
   `OTEL_RESOURCE_ATTRIBUTES=lane=<handle>` (the one unrun claim from the
   research note — the first issue proves it live). Yields real `cost_usd`
   with no pricing table. The same receiver accepts codex's native OTel
   later. The conductor opts in by exporting to the same endpoint with
   `lane=conductor` — cross-machine is fine (WSL localhost forwarding).

## Core (keystone commit first; schema strictly additive)

New event types for usage/cost/tool-activity carrying `model`, `lane`,
`role`, tokens by tier, `cost_usd` where authoritative. Selectors: per-lane
cost totals, spend rate over a rolling window, per-model breakdown, session
totals, and the worker/conductor/auxiliary split. Dollars come from OTel;
sessionlog-only data shows tokens without invented dollars (pricing-table
estimation is an explicit stretch, and anything estimated is marked so).

## UI

- **Spend ticker** panel: live total, $/hour rate, the
  worker/conductor/auxiliary split, per-lane mini-bars.
- **Cost column** in the worktree table; **per-session cost in replay** —
  click a lane, see what that feature cost; model badges.
- **All panels collapsible** (persisted); collisions default-on.
- **Scene meaning-fixes, bounded:** every visual channel gets labeled, mapped
  to a real metric, or removed — size, axes, and motion must each have an
  answer. The full redesign stays prd2.

Honesty note for the UI: on subscription plans the dollars are notional (flat
rate) — the ticker's real meaning is efficiency and rate-limit budget, with
dollars as the universal unit. Copy says so.

## Non-goals

Proxy capture, Langfuse forwarding, task-list metrics, the catch-up digest,
the full viz redesign — ladder items (see `docs/roadmap.md`), not prd1.

## Definition of demo

Run a real wave with telemetry on: dollars tick live per lane; the overhead
ratio is visible; replay a finished lane and read its cost; answer "what did
that feature cost me" with one click.

## Process (continuity ruling, lessons integrated)

Same fleet method as v0: groomed fenced issues with deps and models; prompts
generated from issue bodies; `dispatch.sh`; `gate.sh` landing (fence audit,
NUL check, stranded-work check, quiet suite + typecheck, **load gate — 4x
concurrent runs — for any test-touching issue**); lockfile hygiene in the
landing step; workers never run git in sibling worktrees; `workmux send` only
to idle agents; browser verification for every UI issue; docs-refresh issue
at the tail.
