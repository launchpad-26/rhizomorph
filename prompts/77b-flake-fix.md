# 77b — Fix the gate-held flake (lane 77, branch `77-attention-strip`)

You are resuming lane 77. The branch already has 2 commits and its work is
otherwise DONE. The landing gate HELD it on exactly one flake under 4×
concurrent load:

- 1 failure in 12 runs: `AttentionStripView — calm › renders ALL CLEAR with
  the evidence line, never bare reassurance (ruling 14)` — failed at 5207ms
  (vitest's default 5000ms test timeout).

Read your original brief first: `prompts/77-attention-strip.md` (in this
worktree). It remains your contract, including the fence.

## Evidence gathered by the conductor

The test (`packages/web/src/panels/attention/AttentionStripView.test.tsx:37`)
is **synchronous** — no awaits, no dynamic imports. Each `it` in the calm
describe rebuilds a real fleet via
`reduceAll(fixtureHistory(fleet20Spec(), NOW))` + `buildFleet(...)` inside the
test body. The pathology describe below it already hoists its fleet to
describe scope. Under 4× concurrent suite runs the box is CPU-starved and a
synchronous test doing that much work per invocation can exceed 5s of wall
time. Working hypothesis: this is a **cost problem, not an async race** —
but verify that yourself before fixing; if you find a genuine async boundary
racing, remove the race instead.

## The fix must remove the cost, not hide it

- ALLOWED: hoist/share fixture computation (module scope, describe scope, or
  a memoised `fleetFor`), so the expensive build happens once per spec, not
  once per test. A cheaper fixture spec is acceptable only if the test's
  meaning is fully preserved (the evidence figures 20/20/20/0 stay real).
- FORBIDDEN: raising `testTimeout` anywhere, retries, `.skip`, weakening or
  rewording the ruling-14 assertions.

## Measure, don't assert

Before finishing, prove it under the same conditions that caught it — from
the worktree root, 3 batches of 4 concurrent full-suite runs:

```sh
for b in 1 2 3; do
  for c in 1 2 3 4; do (npm test >/tmp/l77-$b-$c.log 2>&1; echo $? >/tmp/l77-$b-$c.rc) & done
  wait
done
grep -L '^0' /tmp/l77-*.rc || echo "12/12 GREEN"
```

Report the result in your final commit message.

## RULES (unchanged from your original dispatch)

- Fence: `packages/web/src/panels/attention/**` only.
- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED.** Never push, never merge, never
  switch branches.
- Root `npm test` and `npm run typecheck` green before you finish.
- Build for a stranger's machine — no user-specific paths, no assumptions
  about this box.
- If blocked, print `BLOCKED: <need>` and stop.
