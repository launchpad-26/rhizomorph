## Direction (prd5 wave 4 — document the finished application)

prd5 turned the instrument into a navigable, animated, production-ready
application. Document it against the layman bar (prd4 ruling 1):

- **README.md + docs/demo.md**: the camera (gestures + keys, incl. `1`
  fit / `0` reset / `n` jump-to-needs-you / fleet verbs), the cord-cut
  and what a scar means, the hide-finished toggle, the pause control and
  reduced-motion behavior, amber aging bands. A first-time reader learns
  what they can DO, not just what they see.
- **docs/architecture.md decision log**: prd5 rulings 1–6 (camera
  vehicles with the probe receipts; the cord-cut's three stages + the
  never-fade-to-nothing law; motion budget classes + cap-of-5 as the
  motion extension of "coalesced, never invented"; springs closed-form
  with the stability law; amber-age modulates-never-promotes; WCAG
  2.2.2 pause). Fold in any scope comments wave 1–3 lanes left on this
  issue.
- **docs/screenshots/**: regenerate the full set from the live app —
  include one mid-cut frame or a scar-bearing scene if you can catch it
  (a fixture or a finished lane), and the paused state.
- Every command verified by running it (say which); no personal paths;
  ruling numbers cited.

## Fence (may touch ONLY)

- `README.md`
- `docs/demo.md`, `docs/architecture.md`
- `docs/screenshots/**`

## Blocked by

#100, #101, #102, #103, #104 (documents what landed). **Model:** sonnet.
**Wave:** 4.

## Definition of done

- Root `npm test` + `npm run typecheck` green (docs-only; prove the tree
  unbroken).
- Screenshots regenerated from the live app and committed.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED.** Never push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
