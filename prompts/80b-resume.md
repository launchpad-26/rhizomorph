# 80b — Resume lane 80 (burn strip), branch `80-burn-strip`

The previous agent on this lane lost its session mid-work (host wipe). Its
uncommitted work-in-progress SURVIVED in this worktree:

```
 M packages/web/src/panels/burn/index.tsx
?? packages/web/src/panels/burn/format.test.ts
?? packages/web/src/panels/burn/format.ts
?? packages/web/src/panels/burn/index.test.tsx
```

Your issue brief is `prompts/80-burn-strip.md` (in this worktree). Read it
first — it is your contract: direction, fence, definition of done.

Then: review the surviving work-in-progress with a critical eye — it is
unfinished, not blessed. Keep what is right, finish what is missing, correct
what is wrong. Do not discard it wholesale unless it genuinely conflicts
with the brief; if you do discard anything, say why in the commit message.

## RULES (unchanged from the original dispatch)

- Fence: `packages/web/src/panels/burn/**` and
  `packages/web/src/panels/spend/**` only.
- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED.** The previous agent lost everything
  by not committing — do not repeat that. Commit in coherent increments.
  Never push, never merge, never switch branches.
- Root `npm test` and `npm run typecheck` green before you finish.
- Build for a stranger's machine — no user-specific paths, no assumptions
  about this box.
- If blocked, print `BLOCKED: <need>` and stop.
