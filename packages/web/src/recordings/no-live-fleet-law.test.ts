import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * "A LIBRARY, NOT A SECOND OVERVIEW" (prd16 ruling 4, item 5) — the
 * dashboard-IA spike's warning was against a second surface competing to
 * answer "what is happening now"; `/recordings` answers "what did we
 * record", which nothing else does, and must stay that. Not a property a
 * rendered-output test can hold onto (a component added tomorrow that pulls
 * in the fleet would pass every behavioural test and still be the second
 * overview the ruling forbids) — same tactic `drawer/readonly.test.ts` and
 * `panels/ledger/no-panel-refolds.test.ts` use: grep the source directly.
 *
 * **The walk is recursive, and the floor is derived, not typed** (prd45 w1,
 * #44) — the flat `readdirSync` this law used to run only ever saw files
 * sitting directly in `recordings/`, the same shape
 * `lab/no-live-fleet-law.test.ts` (#206) carried until its own 2026-08-08
 * audit finding: a subdirectory added under the governed root was invisible
 * to the law, and the old `toBeGreaterThan(3)` floor passed vacuously on
 * whatever the shallow walk could still see. A first pass at this fix
 * replaced `3` with a tighter literal (`13`) — still a hardcode, and a
 * verify pass caught it: a walk that drops exactly one file still clears a
 * remembered count with room to spare the moment the tree grows past it, and
 * the same literal goes red for an unrelated reason the day a file is
 * legitimately deleted. The floor below is computed instead, from
 * `realSourceFileNames()` — Node's own recursive `readdirSync` (no code
 * shared with the hand-rolled `walkSourceFiles` recursion below it), so the
 * expectation moves with the tree rather than with whoever last ran the
 * test. `recordings/` has zero subdirectories today, so that gap is latent
 * here, not live — but it is the exact shape that let
 * `lab/branching/geometry.ts` import `../../scene/palette.js` unseen before
 * that audit. `walkSourceFiles` below reuses the recursive shape
 * `lab/no-live-fleet-law.test.ts` proved out rather than writing a third
 * walker for this package.
 *
 * The equality check on its own re-opened the exact hole it closed: `[]`
 * equals `[]`, so a round-two verify pass found the whole law voids out if
 * both traversals collapse to nothing (the file moving, `RECORDINGS_DIR`
 * resolving elsewhere, every file being filtered out). The restored
 * non-vacuity floor (`sourceFiles().length` > 0, first test below) is
 * deliberately not a completeness bound — it does not say how many files
 * there should be, only that there must be more than zero — so it cannot
 * rot the way the rejected `>= 13` did, and is not a reintroduction of it.
 *
 * **The recursive branch is exercised, not just provably correct** (#76). At
 * #44's landing, `recordings/` had zero subdirectories, so
 * `walkSourceFiles`'s `statSync(...).isDirectory()` branch was never taken by
 * the committed suite — the walk could regress to a flat `readdirSync` and
 * nothing here would notice. #76 was filed to make that decision explicit
 * rather than leave it implicit, and the decision taken is: commit a fixture.
 * `recursion-fixture/walked-marker.ts` is a real, nested, deliberately
 * innocuous source file — see its own file doc for why it matches none of
 * `FORBIDDEN_PATTERNS`, and for the honest caveat that deleting it does not
 * turn anything red, it only lets the recursive branch quietly go dark
 * again. EXECUTED on the committed tree (issue #76): suite green with the
 * fixture and the recursion intact; red — the equality test names the
 * missing nested file — with the fixture present and the recursion in
 * `walkSourceFiles` disabled. The counter-argument (a fixture directory is
 * itself something future readers must not delete) was weighed and rejected
 * here in favour of matching the `lab/` law's own history: an unexercised
 * recursive branch is exactly the shape that hid `lab/branching/geometry.ts`
 * from its old flat walk for as long as the tree stayed shallow.
 */

const RECORDINGS_DIR = path.dirname(fileURLToPath(import.meta.url))

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\buseFleet\b/,
  /\bFleetProvider\b/,
  /\bbuildFleet\b/,
  /from ['"]\.\.\/panels\//,
  /from ['"]\.\.\/scene\//,
  // No re-fold of the whole log either — this page reads `/api/sessions`'s
  // already-computed listing (`log/listing.ts`), never the raw log itself.
  /\breduceAll\(/,
]

interface RecordingsSourceFile {
  readonly name: string
  readonly text: string
}

/**
 * Recursive walk, reusing the `walkSourceFiles` shape
 * `lab/no-live-fleet-law.test.ts` carries. `name` is relative to `root`, so
 * it stays readable (e.g. `some/nested/file.ts`) no matter how deep the file
 * sits — and so a file added at any depth is checked, or turns this law red.
 */
function walkSourceFiles(dir: string, root: string = dir): RecordingsSourceFile[] {
  const out: RecordingsSourceFile[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walkSourceFiles(full, root))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    out.push({ name: path.relative(root, full), text: readFileSync(full, 'utf8') })
  }
  return out
}

function sourceFiles(): RecordingsSourceFile[] {
  return walkSourceFiles(RECORDINGS_DIR)
}

/**
 * The floor's independent measurement — not the walk under test. Node's own
 * recursive `readdirSync` (`{ recursive: true }`, v18.17+/20.1+) does its
 * own traversal in the runtime rather than the hand-rolled recursion
 * `walkSourceFiles` above carries, so a bug in that recursion (dropping a
 * subdirectory, the historical `lab/` failure this law is modeled on)
 * cannot also be present here by construction. Filtered by the same
 * predicates as `walkSourceFiles` — "governed source file" means the same
 * thing on both sides — but the *traversal* is a second, unrelated
 * mechanism, which is the property that makes comparing the two non-vacuous.
 */
function realSourceFileNames(): string[] {
  return readdirSync(RECORDINGS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => !entry.split(path.sep).some((segment) => segment === 'node_modules' || segment === 'dist'))
    .filter((entry) => statSync(path.join(RECORDINGS_DIR, entry)).isFile())
    .filter((entry) => /\.(ts|tsx)$/.test(entry))
    .filter((entry) => !/\.test\.tsx?$/.test(entry))
    .sort()
}

describe('the recordings library renders no live-fleet surface (prd16 ruling 4, item 5)', () => {
  it('has source files to check at all — an empty walk proves nothing', () => {
    // A NON-VACUITY floor, not a completeness floor — it makes no claim
    // about how many files the directory should contain, which is exactly
    // why it does not rot the way a remembered `>= 13` did (a legitimate
    // add or delete never changes whether this is `> 0`). Its job is
    // narrower and different from the equality check below: without it,
    // `sourceFiles()` and `realSourceFileNames()` both collapsing to `[]` —
    // the law's own file moving, `RECORDINGS_DIR` resolving to the wrong
    // path, or every file in the directory being filtered out (e.g. by an
    // extension or naming-convention change) — would satisfy `toEqual`
    // vacuously, `[]` equalling `[]`. Do not delete this thinking the
    // equality assertion below already subsumes it; `toEqual` alone cannot
    // tell "nothing to check" from "checked everything".
    expect(sourceFiles().length).toBeGreaterThan(0)
  })

  it('the walk finds every real source file the governed root contains, at any depth — a shallow or truncated walk proves nothing', () => {
    // Computed from the tree at run time via a second traversal mechanism
    // (`realSourceFileNames`, above), not a count typed once and left to
    // rot: a walk that drops a file — anywhere, at any depth — fails this
    // immediately, and a file legitimately added or removed moves both
    // sides of the comparison together, so the assertion never goes stale
    // the way a remembered literal would.
    expect(sourceFiles().map((file) => file.name).sort()).toEqual(realSourceFileNames())
  })

  it('imports no fleet/panel/scene machinery, and folds nothing itself', () => {
    for (const file of sourceFiles()) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(file.text, `${file.name} matches forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('the detector bites — a fleet import added tomorrow would be caught', () => {
    expect(FORBIDDEN_PATTERNS.some((pattern) => pattern.test("import { useFleet } from '../fleet/index.js'"))).toBe(
      true,
    )
    expect(
      FORBIDDEN_PATTERNS.some((pattern) => pattern.test("import { costCellText } from '../panels/fleet/format.js'")),
    ).toBe(true)
  })
})
