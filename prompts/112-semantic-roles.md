## Direction (prd7 ruling 2 — the prerequisite, and it must not change a pixel)

Our scene laws are pinned to **shape-named** mark roles. Measured on
main: **31 assertions across 9 shape names** (`raised-hand` ×6,
`scar-bloom` ×5, `scar-mark` ×4, `knot` ×4, `cut` ×4, `arc` ×3,
`chevron` ×2, `cartouche` ×2, `rogue-barb` ×1), and **51 `role:` usages**
in `packages/web/src/scene/marks/`. Those names ARE the shapes prd7
removes next. Rename roles to what they MEAN, so the law layer stops
being coupled to the form layer forever.

**The rename is the whole job. There must be NO visual change** — the
same pixels, the same geometry, only the vocabulary and the assertions
move. If you find yourself changing a coordinate, stop.

Suggested mapping (yours to refine, but justify any departure):

| now (shape) | becomes (meaning) |
|---|---|
| `chevron` | `expensive-mark` |
| `cut` | `severed` |
| `raised-hand` | `summons` |
| `knot` | `looping-mark` |
| `cartouche` | `rank-enclosure` |
| `rogue-barb`, `fence`, `arc` | `off-fence-mark`, `off-fence-reach`, `off-fence-victim` |
| `node-thorn`, `node-seal` | `pathology-mark`, `done-mark` |
| `scar-mark`, `scar-bloom`, `scar` | keep — already semantic |

Roles that are already about *substance* rather than shape (`thread`,
`node`, `label`, `pulse`, `glow`, `root-*`, `homeward`, `filament`) stay
as they are.

**Also in scope (one small addition):** a `structuredClone` conformance
test proving every emitted mark is plain data — no functions, no class
instances, no cycles. That is the guard that keeps the painter swappable
(ruling 1) and it belongs with the vocabulary.

## How the laws get restated (read this twice)

An assertion like `expect(of(marks, LANE.expensive, 'chevron')).toHaveLength(3)`
becomes an assertion about MEANING, not count-of-shapes: the expensive
lane carries its expensive marking. Prefer
`toHaveLength(n)` on the semantic role where the count is itself lawful
(two cut strokes were a deliberate "severed twice" reading — keep the
count and say so in the test name); use presence/absence where the count
was incidental to the old drawing. **Every law must survive at equal or
greater strength. A law you cannot restate is a law you must keep as it
is and flag in your report — do not delete or weaken one to make the
rename tidy.** The conductor reviews this diff specifically for
weakening.

## Fence (may touch ONLY)

- `packages/web/src/scene/marks/types.ts`
- `packages/web/src/scene/marks/{thread,node,root,light,frame,glyphs,index}.ts`
- `packages/web/src/scene/marks.test.ts`
- `packages/web/src/scene/retire.ts`, `retire.test.ts`
- `packages/web/src/scene/paint.ts` (role→painter dispatch only)
- `packages/web/src/scene/SceneView.tsx` (only if it names a role)

## Blocked by

Nothing. **Model:** opus. **Wave:** 1 (prerequisite).

## Definition of done

- Zero visual change: state how you convinced yourself (e.g. the mark
  stream before/after is identical modulo role names — a diff of the
  serialized display list with roles normalised is the strongest proof
  and cheap to write).
- All existing laws present and no weaker; `structuredClone` conformance
  test added; no shape-named role left in the vocabulary except where
  the shape IS the meaning (say which and why).
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
