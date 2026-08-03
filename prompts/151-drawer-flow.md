You are a worker agent on rhizomorph fixing an operator-reported UI
regression. Read the issue below IN FULL, then the drawer source
(drawer/index.tsx and every section component) BEFORE changing
anything. The fix is structural simplicity, not cleverness.

YOUR ISSUE — #151:

## Direction

REGRESSION (operator-reported, conductor browser-confirmed 2026-08-04
~11:50): the lane drawer's sections OVERPRINT each other after three
landings touched it (#132 TRACE section, #134 tail-first conversation,
#149 WHY section) — each green in isolation, broken in combination.
Observed on a real drawer (lane 148): conversation text and ACTIVITY rows
render at the same offsets (text stamped through text); the conversation
area is collapsed to ~one line under its header while its content bleeds
into siblings; section headers (ACTIVITY, WHY) sit on top of other
sections' content.

Fix — restore the drawer to one boring, bulletproof flow column:

1. The drawer is a single flex column in DOCUMENT FLOW: header/vitals →
   CONVERSATION → ACTIVITY → WHY → TRACE → ATTACH. No absolute
   positioning between sections; no fixed heights that siblings can
   collide with; no negative margins.
2. CONVERSATION gets the classic bounded-scroll pattern (flex child with
   `min-height: 0` + its own `overflow-y: auto`, `scrollbar-gutter:
   stable` per #136) so tail-following scrolls INSIDE its box and can
   never paint over siblings. Verify the #134 behaviors survive: opens at
   tail, load-earlier works, follow pins to bottom.
3. Each other section owns its height honestly (content-sized or its own
   bounded scroll — WHY and ACTIVITY lists cap with internal scroll
   rather than growing unbounded).
4. Root-cause note REQUIRED in your summary: name the exact CSS/structure
   interaction that caused the overprint (which landing introduced which
   half), so the lesson survives.
5. Test what's testable (DOM structure: sections are siblings in flow,
   conversation container has the bounded-scroll classes; a jsdom
   "no element has position:absolute among direct section children"
   structural assertion) — and know honestly that the PROOF is the
   conductor's browser check at the gate; say so in the summary.

## Fence (may touch ONLY)

- `packages/web/src/drawer/` (all files)
- `packages/web/src/why/` (all files — its internal layout may contribute)

## Blocked by

Nothing (no active lane touches web). **Model:** sonnet. **Wave:**
regression fix — lands only after the conductor's browser verification.

## Definition of done

- One flow column, structural assertions in tests, #134 behaviors intact,
  root-cause named.
- Root `npm test` + `npm run typecheck` green.
- Conductor browser-verifies BEFORE the issue closes (gate + screenshot).

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; the
legibility floor and readonly laws stay green; if you cannot proceed
print "BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary including
the required root-cause note.
