## Direction (prd5 ruling 5 — amber escalates with age, strip side)

A needs-you summons must distinguish "just asked" from "asked 40 minutes
ago." The ladder's rungs remain the only severity AXIS — age modulates
INSISTENCE within a rung, never promotes across rungs.

- **Chips gain a count-up**: the age already rendered on each chip
  becomes visually load-bearing — as a summons ages, the chip grows more
  insistent: brighter needs-you ink and a slow pulse whose period
  LENGTHENS-not-quickens with urgency (calm authority, not panic).
  Suggested bands: <2 min quiet; 2–10 min full needs-you ink; >10 min
  slow pulse + count-up emphasized. Pin the bands as exported constants
  with tests.
- **Tab signal ages too**: `useTabSignal`'s title already says "● N need
  you" — when the OLDEST summons crosses the top band, the title carries
  it: "● N need you (oldest 43m)".
- Escalation respects reduced-motion (pulse degrades to the static
  brighter ink) and never applies to BROKEN (red is already maximal) or
  NOTICE (cyan stays quiet).
- All motion here must fit the alarm/event class of the motion budget
  (#101 defines it in the same prd — you land independently; use
  conservative literals and note that #101's constants may later absorb
  them: leave a one-line comment marking the seam).

Load `emil-design-eng` before styling; say so in your report.

## Fence (may touch ONLY)

- `packages/web/src/panels/attention/**`

## Blocked by

Nothing (fence disjoint from all wave-1 lanes). **Model:** sonnet.
**Wave:** 1.

## Definition of done

- Tests: band thresholds (constants exported and read by tests); chip at
  each band renders the right ink/pulse class; oldest-summons title
  suffix; broken/notice unaffected; reduced-motion degradation.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
