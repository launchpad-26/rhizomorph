You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md — they are the contract.
The whole app is merged and working on main: core, server, three collectors,
web shell, three panels, replay, three.js scene, status bar.

YOUR ISSUE — #20 (20. Record today's real decisions in the architecture log)

**Fence (may touch ONLY):** `docs/architecture.md` (Decisions log section only — append, never rewrite existing text)
**Model:** sonnet

The architecture doc's Decisions log stops at the three pre-code decisions. Five
real defects and design corrections were found while building today and none are
recorded. Append them as dated entries, each stating the decision/defect, the
evidence, and the consequence:

1. **Collector loading is static, not dynamic.** A variable dynamic import
   (`../collectors/${slug}/index.js`) cannot be statically analysed by
   Vite/Rollup, so every collector silently failed to load while the server
   booted happily and emitted only `session.started`. Collectors are now
   imported explicitly. (issue #14)
2. **SSE frames are named, and the client must subscribe by name.** The server
   writes `event: <type>`; a client using only `onmessage` receives every frame
   and drops it, because `onmessage` fires only for unnamed frames. Both
   packages were green in isolation because the web test double called
   `onmessage` directly. Test doubles must imitate the real wire format.
   (issue #17)
3. **Panels must distinguish "connected but idle" from "not connected".**
   Otherwise the dashboard's own empty state is indistinguishable from the
   failure it exists to reveal. (issue #18)
4. **Source files must be plain UTF-8.** One stray NUL byte made
   `selectors/collisions.ts` binary to git — undiffable and unmergeable — while
   still compiling and passing tests.
5. **Cross-fence orphans need an owner.** When core removed the scaffold's
   placeholder export, the two files importing it belonged to no issue's fence,
   so the root gate went red for every branch at once. Fences must cover every
   file a change can orphan.

Read the referenced issues (`gh issue view <n>`) for the evidence. Match the
existing doc's voice: decision + why, plainly stated.

**DoD:** entries appended under Decisions log, nothing else altered (`git diff`
shows only additions); `npm test` + `npm run typecheck` still green. No NUL
bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (two other agents are working in
parallel right now); consume core selectors, never edit packages/core;
small conventional commits; never push or merge; no NUL bytes; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
