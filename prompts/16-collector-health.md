You are a worker agent building The Observatory. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md — they are the contract.
The whole spine is already merged on main: core, server, three collectors,
web shell, three panels, replay, and the three.js scene. Match the existing
theme tokens in packages/web/src/theme/theme.css.

YOUR ISSUE — #16 (16. Surface collector health (disabled/errored) in the UI)

**Fence (may touch ONLY):** `packages/web/src/app/ConnectionBadge.tsx`, `packages/web/src/app/StatusBar.tsx` (new), `packages/web/src/app/Shell.tsx` (mount the bar only)
**Model:** sonnet

prd0 promises each data source is optional and degrades gracefully, and the
architecture emits `collector.disabled` / `collector.error` / `session.started`
for exactly that. Right now nothing in the UI surfaces it: if tmux is absent or
a collector dies, the dashboard silently looks idle — indistinguishable from a
quiet swarm. That is the failure mode this app exists to make visible.

Add a status bar (in the shell's frame) showing, per source (git / tmux /
workmux): live, disabled, or errored — driven by the reducer state, plus the SSE
connection state already tracked in `ConnectionBadge`. Errors should show their
last message on hover/focus. Match the existing theme tokens; keep it one quiet
line, not a dialog.

**DoD:** render tests covering live / disabled / errored per source using core
fixture events; `npm test` and `npm run typecheck` green from the repo root. No
NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (other agents are working in parallel);
consume core selectors, never edit packages/core; small conventional commits;
never push or merge; no NUL bytes in source; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
