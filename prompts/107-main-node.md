## Direction (prd6 ruling 5 — the main node opens the conductor's conversation)

The root-mass is the only thing on screen you cannot click. Fix that:
clicking MAIN opens the same drawer the lanes use, showing **the
conductor's own session, CLI-style**, plus main's vitals.

**Scene side:** the root-mass becomes a hit target (`SceneView.tsx`'s
`laneAt` neighbourhood — it must work under the camera transform landed
in #100, world coordinates with a screen-sized tolerance). Clicking it
selects a `main` pseudo-lane; clicking again or Esc clears, exactly like
a lane. The root-mass shows the same spotlight affordance a selected lane
gets — the operator must see what they picked.

**Selection side:** `fleet/selection.tsx` gains the `main` identity. It
is NOT a lane in the fleet object — do not fabricate a Lane. Keep it a
distinct, explicit value so no panel mistakes it for a worker (the fleet
table must not grow a MAIN row; the feed filter must handle it
gracefully — either "no filter" or conductor-attributed events, your
call, stated in a comment).

**Drawer side** (`drawer/**`): when `main` is selected, the drawer shows:
- header MAIN + the branch name;
- **vitals for main**: current branch, landings this session, total burn
  (the figures the burn strip and ledger already derive — reuse their
  formatters, do not re-derive);
- **the conductor's conversation**, in the same CLI-style component #94
  built (reuse `Conversation`, do not fork it);
- ATTACH for the conductor's own pane if an identity is available,
  copies-never-executes as always.

**Server side** (`packages/server/src/api/transcript.ts`): resolve the
conductor's session. The attribution machinery already exists
(`findLaneAttribution` reads `llm.usage`/`tool.activity`/`llm.cost`
events) and #88 made conductor `llm.cost` events visible in the fold —
use the conductor's attribution to find its session JSONL, the same way
a lane's is found. Keep the route shape (`/api/transcript/:lane` with
`main` as the identifier is fine — no new route; the read-only law test
greps for exactly this). **Where the conductor is not instrumented, say
so in the gap voice (law 12): WHAT is missing → WHY → the command that
fixes it.** Never render emptiness as if it were silence.

Load `emil-design-eng` before styling the MAIN drawer header/vitals; say
so in your report.

## Fence (may touch ONLY)

- `packages/server/src/api/transcript.ts`, `transcript.test.ts`
- `packages/web/src/drawer/**`
- `packages/web/src/fleet/selection.tsx`, `selection.test.tsx`
- `packages/web/src/scene/SceneView.tsx`, `SceneView.test.tsx`
- `packages/web/src/scene/index.tsx`

Do NOT touch scene/geometry.ts, retire.ts, marks/** — #106 owns them
this wave.

## Blocked by

Nothing (fence disjoint from #106). **Model:** opus. **Wave:** 1.

## Definition of done

- Tests: root-mass hit target works under a non-identity camera
  transform; selecting main opens the drawer with vitals + conversation;
  the fleet table grows no MAIN row; Esc/toggle clears; conductor
  transcript resolves from real attribution; uninstrumented conductor
  produces the gap voice, not blankness; read-only law test still green
  (GET only, no new routes).
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures reported
  verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
