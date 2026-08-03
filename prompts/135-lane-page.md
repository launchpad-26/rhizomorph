You are a worker agent on rhizomorph (prd9: the trace era).
You own exactly one issue — the operator-ruled lane page.

FIRST read docs/prd9.md, then docs/research/2026-08-03-langfuse-ui-study.md,
then packages/web/src/trace/ (landed #132 — your components),
packages/web/src/drawer/Conversation.tsx (import, never fork), and
packages/web/src/app/Shell.tsx before writing any code.

YOUR ISSUE — #135:

## Direction

prd9 B1b — the deep-linkable lane page, per the operator's ruling
(2026-08-03: "build the lane page this week"). A shareable URL that gives
one lane real room: conversation beside trace, spend and activity beneath.
The balcony stays the product's home; this page is where you go DEEPER on
one lane — it must reuse, never fork.

1. **Routing — no new dependency.** A minimal hand-rolled history-API
   router for exactly this route family: `/` (the balcony, unchanged) and
   `/lane/:handle`. Back/forward work; Esc on the page returns to `/`.
   The lean-dependency culture is deliberate (see docs/research prd5
   implementation-vehicles note) — do not add react-router or any routing
   package.
2. **The page** — new `packages/web/src/lane-page/`:
   - Two columns: CONVERSATION (import and reuse the drawer's existing
     `Conversation` component — do not fork it) and TRACE (reuse #132's
     `TraceTree` with its gantt affordance).
   - Beneath: the lane's spend detail (existing `LaneSpend` selectors —
     output-led tokens, flagged `est.` dollars where estimates apply,
     thread sub-rows per the existing ledger rules) and the compact
     activity ledger (reuse `drawer/activity`).
   - Header: lane handle, role, state glyph, branch — from the same
     derived objects the fleet table reads (`buildFleet` — one object,
     never re-derive).
   - Unknown handle → the honest-gap voice ("no lane <handle> in this
     session"), never a crash or a blank.
3. **Entry points**: an `open page ↗` affordance in the drawer's header
   (drawer keeps working exactly as today), and the page URL is the
   shareable artifact.
4. **Replay-safe by construction**: the page renders inside the existing
   Shell/StreamContext so mode (live/replay) and the replay bar behave
   identically to the balcony; one test proves the page renders folded
   replay state at scrub time.
5. **Server** — `packages/server/src/server/static.ts`: SPA fallback so
   GET `/lane/<anything>` serves the app shell (the API and OTLP routes
   keep precedence). Read-only constitution untouched.

## Fence (may touch ONLY)

- `packages/web/src/lane-page/` (new)
- `packages/web/src/app/router.ts` (new), `packages/web/src/app/router.test.ts` (new)
- `packages/web/src/App.tsx`, `packages/web/src/App.test.tsx`
- `packages/web/src/app/Shell.tsx`
- `packages/web/src/drawer/index.tsx`, `packages/web/src/drawer/index.test.tsx` (the ↗ affordance only — Conversation/useTranscript belong to #134, do not touch them)
- `packages/server/src/server/static.ts`, `packages/server/src/server/static.test.ts`

## Blocked by

#132 (must be landed on main first — shared App/drawer surface).
**Model:** sonnet. **Wave:** B1b (lands alone).

## Definition of done

- `/lane/<handle>` deep-links cold (fresh browser load) to a working page;
  back/Esc return to the balcony; unknown handle gets the honest gap.
- Conversation and TraceTree are the SAME components the drawer uses
  (imports, not copies — prove by imports).
- Spend detail shows flagged estimates exactly as the ledger does; no
  unlabelled totals anywhere.
- Replay scrub renders the page correctly (test).
- SPA fallback tested server-side; `drawer/readonly.test.ts` stays green.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; no new
runtime dependencies; build for a stranger's machine (127.0.0.1, no
personal paths); if you cannot proceed print "BLOCKED: <need>" and
stop; DoD is root 'npm test' + 'npm run typecheck' green, then STOP
with a short summary.
