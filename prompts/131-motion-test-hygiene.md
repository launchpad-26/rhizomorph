You are a worker agent on rhizomorph. You own exactly one issue — a
surgical test-hygiene fix. Read the issue body below; it contains the
full measurement evidence. Touch ONLY the fenced file.

YOUR ISSUE — #131:

## Direction

Gate hygiene: the scene test `slows smoothly — no hitch anywhere along the
ramp` (`packages/web/src/scene/motion.test.ts:221`) held two landings this
week (#124 at 4/12 under load with two live sibling agents, #130 at 1/12
with one). Measured cause — NOT a race: the test is pure but runs ~112,500
loop steps with TWO `expect()` calls per step (~225k chai assertions).
Every observed failure duration was 5.1–9.6s: it crosses vitest's 5s
default test timeout under CPU contention. Quiet boxes pass 12/12.

The fix keeps the law's full power and removes the framework cost — it
does NOT widen any timeout (standing rule):

- Keep the exact 8ms resolution and the exact bound (0.05).
- Inside the loop: plain JS only — track `maxJump` and the age at which it
  occurred. No `expect` in the loop.
- After the loop: ONE assertion on `maxJump` with the argmax age in the
  failure message (preserving the current message's diagnostic value:
  "throb jumped at age <N>ms").
- Do not change `alarmPulse`, any constant, any timeout, or any other test.
- While in the file: check the sibling heavy loops (`keeps throbbing past
  the recency span`, `stays inside its band…`) — they sample 200–400
  points, are fine, leave them; touch nothing but the named test unless
  another loop provably has per-step expects in the hundreds of thousands
  (state it in the summary if so).

## Fence (may touch ONLY)

- `packages/web/src/scene/motion.test.ts`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** hygiene (lands alone).

## Definition of done

- The named test asserts the same bound at the same resolution with a
  single post-loop expect carrying the argmax age; its runtime drops to
  tens of milliseconds.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; committing is REQUIRED; NEVER
switch branches, push, merge, or run git in a sibling worktree; no NUL
bytes; do not widen any timeout; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
