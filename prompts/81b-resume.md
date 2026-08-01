# 81b — Resume lane 81 (the scene), branch `81-scene-mycelium`

The previous agent on this lane lost its session mid-work (host wipe). Its
uncommitted rebuild SURVIVED in this worktree — the old constellation scene
deleted, new mycelium modules begun:

```
 D  packages/web/src/scene/CommitField.tsx      (and the rest of the old scene:
 D  packages/web/src/scene/Constellation.tsx     SceneView, Station, Pulses,
 D  packages/web/src/scene/sceneModel.*,          layout.*, fixtures, index,
 D  packages/web/src/scene/Scene*.test.tsx        their tests)
 M  packages/web/src/scene/palette.ts
 ??  packages/web/src/scene/geometry.ts
 ??  packages/web/src/scene/marks/
 ??  packages/web/src/scene/pulses.ts
 ??  packages/web/src/scene/resolve.ts
 ??  packages/web/src/scene/salience.ts
 ??  packages/web/src/scene/settle.ts
```

Your issue brief is `prompts/81-scene-mycelium.md` (in this worktree). Read
it first — it is your contract: direction (mycelium pulse-network, ice-neon,
rulings 21–23 and 29, grafts g2/g3/g6/g7), fence, definition of done. The
spike to improve on is at the sibling worktree branch `spike-c-mycelium` —
read its code through git (`git show spike-c-mycelium:<path>`, `git ls-tree
-r spike-c-mycelium --name-only`) from THIS worktree; never cd into sibling
worktrees.

Then: review the surviving work-in-progress critically — it is unfinished,
not blessed. Keep what is right, finish what is missing, correct what is
wrong. If you discard anything, say why in the commit message.

## RULES (unchanged from the original dispatch)

- Fence: `packages/web/src/scene/**` and `packages/web/package.json` only.
- Work ONLY in this worktree. Never run git commands that WRITE outside it
  (read-only `git show`/`ls-tree` of other branches is fine).
- **Committing your work is REQUIRED.** The previous agent lost everything
  by not committing — do not repeat that. Commit in coherent increments,
  starting reasonably early: get the deletions + skeleton committed once the
  suite is green, then build up.
- Root `npm test` and `npm run typecheck` green before you finish.
- Build for a stranger's machine — no user-specific paths, no assumptions
  about this box.
- If blocked, print `BLOCKED: <need>` and stop.
