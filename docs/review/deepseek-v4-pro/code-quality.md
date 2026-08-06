# Code quality review

**Verdict:**
- Lint **clean** (547 files, 0 warnings). Biome is doing its job.
- Typecheck **clean** across all 3 workspaces. `strict: true`, `noUncheckedIndexedAccess`, no `any`, no `@ts-ignore` in production — the type discipline is genuinely excellent.
- Tests: **3411 passed, 1 failed** (`namespace-law.test.ts:657`, symlink canonicalization). This is a real bug — `git worktree list --porcelain` returns `/private/var/…` but the test's `realDataRoot` is `/var/…`. Not an environment flake; macOS `/tmp` is a symlink to `/private/tmp` and the path normalization doesn't account for it. Worth fixing, not dismissing.

**Where the 112k (actually 90k) lines went:** 53% is tests (47,576 lines). Of the 42,342 production lines: scene rendering consumes 11.4K, fleet derivation 2.9K, collectors 4.3K, selectors 2.3K, events schema 3.2K, reducer 1.4K. The single largest component is `web/src/scene/` at 11.4K lines drawing a single Canvas2D visualization — a lane-network diagram with pulses, thread lines, and a root-mass.

---

## Top 10 findings

### 1. `packages/server/src/collectors/sessionlog/turn-grammar.ts:24-40` — abstraction for one implementation
The `TurnGrammar` interface and `grammarFor()` registry exist solely to serve one implementation: `turn-grammar-claude.ts` (167 lines). The comment explicitly says codex and pi are "later waves" and `grammarFor` returns `null` for every CLI but `'claude'`. The state machine (`turn-shape.ts` 162 lines, `lane-state.ts` 337 lines) takes the grammar as a parameter but is only ever called with the Claude one. **Collapse `turn-grammar.ts` into `turn-grammar-claude.ts`, inline the interface into `turn-shape.ts`. (est. ~80 lines saved)**

### 2. `packages/core/src/collector.ts:105-278` — four of six capability rungs are unreachable
The `AdapterCapabilities` system defines 6 signals × 3 levels, mapped to 5 rungs (L0–L4) with `deriveRung`, `nextRung`, `rungInfo`, `mergeCapabilities`, `honestCapabilities`, `absentCapabilities`, `capabilitiesOf`, `UNKNOWN_CAPABILITIES`. Only L0, L1, and L4 are actually reachable today. L2 ("beacon") and L3 ("PTY wrapper") exist speculatively. The `mergeCapabilities` function exists to combine multiple collectors' capabilities per lane, but most lanes have exactly one collector. **Delete L2/L3 logic from `deriveRung`/`rungInfo`/`nextRung`, simplify to the 3 actual rungs. (est. ~120 lines saved)**

### 3. `packages/core/src/fixtures.ts` + `packages/web/src/fleet/fixtures.ts` — two fixture factories, same purpose
Core has 829 lines of fixture generation (event factories, clock stepping, lane builders). Web has 733 lines doing the same thing but emitting fleet-level synthetic histories (`fleet20Spec`, `pathologySpec`, `finishedSpec`). Both use core's `createEvent`, both fold through the real reducer. **Merge web fixtures into core, export the 3 spec factories from there. (est. ~400 lines saved in duplication)**

### 4. `packages/web/src/scene/marks.test.ts` — 3772 lines, one file
A single test file longer than every production file in the scene except `marks/node.ts`. It tests layout, roles, paint output, root growth, retirement, pulsing, and dissolution — sprawling integration tests masquerading as unit tests for "marks." **Split into per-concern test files matching the production module boundaries that already exist (node, thread, root, dissolve, ambient, light). No line savings, but bisects build time and makes failures findable.**

### 5. PRD/ruling archaeology — 1085 references to documents not in the repo
534 `prdN` and 551 `ruling N` references across production code. `marks/types.ts` alone has 17 PRD refs. When a comment says "prd10 ruling 13–15 rescinded the deletion" or "prd15 ruling 4/5's honesty manifest," the reader must either memorize the PRD corpus or trust the comment blind. The project's own `architecture.md` is not linked from any of these. **Replace PRD/ruling citations with the *rule itself* inline (one sentence). The reference preserved nothing the sentence couldn't. (est. ~200 lines of pure citation noise removed, 0 behavioral change)**

### 6. `packages/web/src/scene/marks/types.ts:1-566` — vocabulary layer over vocabulary layer
The mark role vocabulary has 40+ discriminated union members (`'root-halo'`, `'hyphal-fan'`, `'growth-ring'`, `'dissolution'`, `'absorption'`, `'homeward'`, `'off-fence-reach'`, `'off-fence-grasp'`, etc.), each with 5–20 line JSDoc explanations referencing prd rulings. The `salience.ts` file (212 lines) adds its own brightness/opacity vocabulary on top. The domain language ("mycorrhizal anatomy," "apical tufts," "hyphal fan") asks the reader to learn mycology to understand a dashboard layout. **The drawing is ~11K lines; the domain metaphor is costing more than it's saving. Rename `hyphal-fan` → `root-fan`, `apical-tuft` → `branch-tip`, keep `thread`/`root`/`pulse` which are earned. (est. negligible line savings, real comprehension savings)**

### 7. `packages/server/src/collectors/resilience.ts` + `resume-reconcile.ts` — 341 lines wrapping 4 collectors
Resilience adds retry/backoff/self-heal (185 lines). Resume-reconcile handles boot-time state reconciliation for resumed sessions (156 lines). These wrap exactly 4 collectors in `collector-loader.ts`. The resilience policy has 3 constants (`DEFAULT_FAILURE_THRESHOLD`, `DEFAULT_RETRY_INTERVAL_MS`) that are never overridden at any call site. **Inline the resilience defaults, drop the config interface. (est. ~60 lines saved)**

### 8. Scene geometry pipeline — 8 files for what `layout.ts` could absorb
`geometry/` has 8 files: `bud.ts`, `curves.ts`, `faults.ts`, `filaments.ts`, `layout.ts`, `return.ts`, `ring.ts`, `scale.ts`, `types.ts`. `bud.ts` is 48 lines, `ring.ts` is ~60 lines. Several are thin wrappers around layout calculations. **Merge single-export geometry files below 100 lines into `layout.ts`. (est. ~100 lines of file/import boilerplate saved)**

### 9. `packages/core/src/state.ts:667` — hand-rolled `basename` because "this module runs in the browser"
```ts
export function basename(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? path
}
```
This breaks on Windows paths and duplicates what every runtime has. Since the project targets Node ≥22.2 and ESM, `node:path` is always available. **Use `path.basename`. (est. 4 lines saved, 1 latent cross-platform bug killed)**

### 10. `packages/web/src/fleet/` — 14 files for one derived object
`buildFleet.ts` assembles a `Fleet` from `plumbing.ts` (422 lines of pure helpers), `diagnose.ts`, `fences.ts`, `gaps.ts`, `ladder.ts`, `manifest.ts`, `pathology.ts`, `strokes.ts`, `types.ts`, `constants.ts`, `fixtures.ts`. The re-export block in `buildFleet.ts` (lines 47–83) re-exports 30 symbols from sub-modules for consumer convenience. **Consolidate `gaps.ts` (76 lines), `strokes.ts` (117 lines), `manifest.ts` (83 lines) into `plumbing.ts`. Drop the convenience re-export barrel — consumers can import from the source module. (est. ~120 lines of re-export + file boilerplate saved)**

---

**Total estimated trimmable: ~1,100 lines** without removing any feature. The real waste isn't dead code — it's premature abstraction (TurnGrammar, AdapterCapabilities rungs), duplicate fixture systems, and comment archaeology that outlived its usefulness. The type discipline is strong; the structure is too. But 11.4K lines to draw a lane-network diagram on Canvas2D is the honest answer to "where did the lines go."
