You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

This is a SMALL change on a surface that just landed (#163). Read #163 and its
diff first; do not re-litigate its structure, only its order.

YOUR ISSUE — #164:

## Direction

Operator ruling 2026-08-05, made on the landed tabbed drawer (#163): **the tab
order becomes `ACTIVITY | CONVERSATION | WHY | TRACE`.**

Reason, from the live instrument: opening lane 163's drawer landed on
CONVERSATION, which showed only a gap voice ("NO SESSION LOG …"), while
ACTIVITY had 200 entries waiting. **The drawer should open on a tab that has
something in it, not on an absence.** ACTIVITY is the tab most reliably
populated for any lane, live or folded.

This supersedes the older, never-settled question of whether TRACE belongs
directly under CONVERSATION — that was raised when all four sections were
stacked and fighting for height. With tabs, adjacency costs a click either way,
and the operator judged default-content the more valuable property.

Scope is deliberately small:

1. Reorder the tabs to `ACTIVITY | CONVERSATION | WHY | TRACE`.
2. **ACTIVITY is the default selected tab** when a drawer opens.
3. Nothing else changes — counts on labels, the pinned vitals header, the
   single scroll region, keyboard cycling and the WHY→ACTIVITY jump all keep
   working exactly as #163 built them.

Laws that must survive, test-stated:

- `drawer/readonly.test.ts` stays green untouched.
- The #136 contrast floor grep-law stays green.
- Every honest-gap voice still renders (the CONVERSATION gap voice above is a
  real one and must still appear when you select that tab).

## Fence (may touch ONLY)

- `packages/web/src/drawer/` (all files)
- `packages/web/src/app/Shell.test.tsx` — it asserts which drawer elements are
  in the document and changing the default tab lands there. (#163 learned this
  the hard way: App never mounts the drawer, Shell does. It is now recorded in
  `.swarm/coupling.txt`.)

## Blocked by

Nothing. **Model:** sonnet. **Wave:** the small defects.

## Definition of done

- Drawer opens on ACTIVITY; order is `ACTIVITY | CONVERSATION | WHY | TRACE`.
- Keyboard cycling still wraps both directions; WHY→ACTIVITY jump still lands.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
