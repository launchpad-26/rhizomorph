You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

This bug is ACTIVELY BREAKING the operator’s use of the product: the
conversation he is reading vanishes whenever events arrive. The mechanism is
located for you in the issue — verify it in the code before fixing, and
verify the fix in a BROWSER with events flowing, because a static check will
call it fixed when it is not.

YOUR ISSUE — #191:

## Direction

Operator report 2026-08-05: *"conversations in the drawer keep falling on and
off randomly… I get the feeling it MAY be because whenever there is an update
it flips back to not displaying as it updates. IF this is the case, the
conversation should remain cached. I have a feeling this may also be applying
to trace."* The instinct is right and the mechanism is in the code.

**Three paths that blank a good transcript. All in
`packages/web/src/drawer/useTranscript.ts`:**

1. **The lane effect wipes to empty on every `lane` identity change**
   (`:277-282`): `setState({...IDLE_TRANSCRIPT, status:'loading'})` — and
   `IDLE_TRANSCRIPT.entries` is `[]`. If the drawer's `lane` prop momentarily
   resolves to `null` (or to a re-derived value) while the fleet re-folds on
   an incoming event, every loaded entry is discarded and refetched. This is
   the operator's "flips back as it updates", exactly.
2. **The `absent` fold keeps entries but flips status** (`:195-202`):
   `{...previous, status:'absent'}` retains `entries` — so if the renderer
   shows the gap voice on `status === 'absent'` INSTEAD of the entries it
   still holds, a single transient absent response blanks a conversation that
   is still in memory. Check the renderer; the state is innocent here.
3. **`restarted` empties the base** (`:209`): a spurious `restarted: true`
   from the server replaces the window rather than extending it. Verify when
   the server sets it — #165 changed how folded-lane paths resolve, so a
   re-resolved path must not read as a restarted log.

**Fix — cache is the ruling, stale-while-revalidate is the shape:**

- **Never render empty while re-resolving.** Keep last-good entries per lane
  (a small keyed cache, or simply: do not reset on a lane value that is
  `null`/unchanged-by-value). Only a genuine switch to a DIFFERENT lane
  clears the view, and even then the outgoing lane's entries may be kept for
  instant return.
- **Loading is an overlay on data, never a replacement for it.** A refresh
  in flight over existing entries shows the entries plus a quiet indicator —
  it must not fall back to the empty or gap state.
- **Absence is only absence when it is real**: if entries are held and the
  server says absent transiently, keep showing them and voice the staleness;
  reserve the gap voice for genuinely-empty state. The honesty law is
  preserved — the surface still says what it knows and when it last knew it —
  it just stops lying by omission.
- **Do the same audit for TRACE** (`drawer/Trace.tsx`), which the operator
  suspects and which is likely the same shape: recomputation or a transient
  empty flipping the gap voice on. If trace turns out clean, say so with
  evidence rather than changing it.

Laws, test-stated:
- Given loaded entries, a re-render caused by an unrelated stream update
  renders the SAME entries (no empty frame) — assert across a simulated
  event burst, which is the operator's exact scenario.
- A transient `absent` response over held entries never renders the gap voice.
- A genuine lane switch shows the new lane's data and never the old lane's.
- A real restart still replaces (never splices two sessions) — the existing
  law, unweakened.

Browser-verify with the fleet actively updating — this bug only appears while
events arrive, so a static check will call it fixed when it is not.

## Fence (may touch ONLY)

- `packages/web/src/drawer/` (all files)

If the flicker's root proves to be the drawer's `lane` prop churning in its
parent (Shell/fleet selection) rather than inside the drawer, print
`BLOCKED: <need>` with the file — do not reach outside. `Shell.test.tsx` is a
known coupling point.

## Blocked by

Nothing. #189 owns server/core; #190 owns tide/replay. **Model:** sonnet.
**Wave:** drawer-cache.

## Definition of done

- No empty frame during updates, in a browser, with events flowing; trace
  audited with a verdict either way; laws test-stated.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
