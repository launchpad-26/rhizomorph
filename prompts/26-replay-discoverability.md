You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST read docs/prd0.md, docs/demo.md (Act 2 is the feature you are fixing)
and packages/web/src/replay/index.tsx. The app is fully merged and running.

YOUR ISSUE — #26 Replay is undiscoverable

**Fence (may touch ONLY):** `packages/web/src/replay/`, `packages/web/src/app/ReplayBar.tsx`
**Model:** sonnet

**Real user report: "I can't seem to find the replay."** Replay is the feature
this app was built for — replaying a swarm's own construction — and a first-time
user looking straight at it did not see it.

Why: the bar reads `LIVE MODE   SESSION  [— select a session —]   Play  1x 4x 16x`
in low-contrast text at the bottom of the window. `Play` is disabled until a
session is chosen, the scrubber reads `0:00 / 0:00`, and the word "replay" never
appears until you are already in replay mode. It reads as a dead status strip,
not a control. (Verified present on screen without scrolling at both 1366×768 and
1920×1080 — this is discoverability, not layout.)

Make it obvious without making it loud — this is an instrument, not a toy:

1. Label the control for what it does before it is used: e.g. a `REPLAY` heading
   on the bar, and a select whose default option reads like an invitation
   (`Replay a recorded session…`) rather than a null state.
2. Give the primary action a one-click path: a **`Replay this session's birth`**
   (or similarly named) button that selects the **richest** available session —
   most events, not merely the oldest, since restarts leave 1-event stubs — and
   starts playback. Prefer event count if the sessions API exposes size; fall
   back to the largest `sizeBytes`.
3. Make disabled state explain itself: while no session is chosen, `Play`'s
   tooltip/aria-label should say a session must be chosen first.
4. After a session is chosen, the scrubber should show its real duration rather
   than `0:00 / 0:00`.
5. Keep the existing `LIVE MODE` / `REPLAY MODE` text and `Return to live`
   working exactly as now, and keep the bar to one quiet line.

Match the theme tokens; no new dependencies.

**DoD:** render tests covering — the invitation label present in live mode, the
one-click button selecting the richest session and entering replay, the disabled
`Play` explaining itself, and duration shown after selection. `npm test` +
`npm run typecheck` green from the repo root, and `npm test --workspace
packages/web` run 5 times with 5/5 passing (a flaky test here blocked a merge
earlier today). No NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE; consume core selectors, never edit
packages/core; small conventional commits; never push or merge; no NUL bytes;
DoD as stated (incl. the 5x flake check), then STOP with a short summary.
