## Direction (prd4 wave 3 — document what landed, honestly)

Refresh the docs for the human-facing instrument:

- **README.md + docs/demo.md**: the layman bar (prd4 ruling 1) is the
  frame — a first-time viewer should learn what things mean and what to do
  next from these pages alone. New palette semantics explained through the
  fleet table (the table is the legend); the scene-centerpiece layout; the
  CLI-style conversation drawer; the parked state and how an operator
  declares it (`.swarm/lanes.json` `parked: true`).
- **docs/architecture.md**: decision-log entries for prd4 — law 9a/9b
  (ruling 3), the brightness-budget constants (CALM_FLOOR/ALARM_FLOOR and
  why broken is exempt), the structured transcript response shape, the
  parked exemption. Plus any scope comments left on this issue by wave-2
  lanes.
- **docs/screenshots/**: regenerate the full set from the live app (a
  server is running at 127.0.0.1:4400 against this repo; restart with
  `npm start -- <repo-path> --port 4400` if needed; `npx playwright` is
  cached and available). Live calm fleet, staged pathology fixture, the
  conversation drawer, replay, and one hero shot of the new scene.
- Every command in the docs verified by running it (say which you ran);
  no personal paths anywhere (stranger rule); ruling numbers cited.

## Fence (may touch ONLY)

- `README.md`
- `docs/demo.md`, `docs/architecture.md`
- `docs/screenshots/**`

## Blocked by

#92, #93, #94, #95 (documents what landed). **Model:** sonnet. **Wave:** 3.

## Definition of done

- Root `npm test` + `npm run typecheck` green (docs-only — prove the tree
  unbroken).
- Screenshots regenerated from the live app and committed.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED.** Never push, never merge, never
  switch branches.
- Build for a stranger's machine — no user-specific paths or assumptions.
- If blocked, print `BLOCKED: <need>` and stop.
