## Direction (prd7 wave 4 — document the form language)

- **README.md + docs/demo.md**: the scene's visual grammar retold now
  that form carries meaning — ribbons whose width is work, taper =
  expensive, pinch = severed, swell = a commit travelling home, length =
  progress, the organic centre that melts as work returns. Say plainly
  that every lane is unique but bounded: the wander is seeded from the
  lane's own name, so the same session always draws the same picture.
- **docs/architecture.md decision log**: prd7 rulings 1–6 with their
  evidence — the profile that reframed the prd (60fps, zero shadowBlur,
  so form not renderer), why NOT WebGL (jsdom cannot execute it; the
  display list keeps the painter swappable anyway), the semantic-role
  migration and why laws must never be weakened to fit a rename, the
  channel table (what may vary, what is locked), marching squares over
  metaballs on measurement (1.28 ms vs 42.8 ms), and the licence traps.
- **docs/screenshots/**: regenerate everything from the live app; include
  a close-up that shows ribbon taper and a lane's individuality, plus the
  organic centre.
- Every command verified by running it (say which); no personal paths;
  ruling numbers cited.

## Fence (may touch ONLY)

- `README.md`
- `docs/demo.md`, `docs/architecture.md`
- `docs/screenshots/**`

## Blocked by

#112, #113, #114. **Model:** sonnet. **Wave:** 4.

## Definition of done

- Root `npm test` + `npm run typecheck` green (docs-only; prove the tree
  unbroken).
- Screenshots regenerated from the live app and committed.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED.** Never push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
