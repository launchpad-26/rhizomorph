/**
 * FIXTURE for `no-live-fleet-law.test.ts` (issue #76) — deliberately
 * committed. Do not delete this file, and do not add `recursion-fixture` to
 * either walk's skip list.
 *
 * `recordings/` otherwise has zero subdirectories, so the law's recursive
 * walk (`walkSourceFiles`'s `statSync(...).isDirectory()` branch) is never
 * taken by the committed tree — the exact shape that let
 * `lab/branching/geometry.ts` go unseen by a flat walk before the
 * 2026-08-08 audit that motivated making this walk recursive in the first
 * place (see this law's file doc, and `lab/no-live-fleet-law.test.ts`'s).
 * This file exists only to put a real, nested source file under the
 * governed root, so that branch is exercised today rather than merely
 * provably correct.
 *
 * Deliberately innocuous: it matches none of `FORBIDDEN_PATTERNS`. Its only
 * job is proving the walk *descends* — salting it with a forbidden import
 * would leave the suite permanently red, and issue #76's definition of done
 * requires the opposite (green with this file present, red only if the
 * recursion itself is removed).
 *
 * Not named `__fixtures__`, unlike `packages/server/src/lab/__fixtures__/`:
 * that convention means "excluded from the walk, read explicitly by the
 * test" (see `model-grammar-law.test.ts`'s `__fixtures__` skip). This
 * directory is the opposite — it must be walked, not skipped — so it is
 * named differently on purpose.
 *
 * Honesty about what this does and doesn't buy: deleting this file does not
 * turn anything red. Both traversals simply stop seeing it and agree again,
 * so the suite stays green and the recursive branch quietly returns to
 * unexercised — this fixture is evidence, not an enforcement mechanism.
 */
export const provesTheRecursiveBranchIsExercised = true
