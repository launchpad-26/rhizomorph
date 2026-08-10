# prd-24 — the seam that lies: what the suite is allowed to prove

> **Status:** proposed

## Problem

227 test files and ~3,470 tests are read — by the cohort, by reviewers, by CI — as proof that
the instrument works. A whole class of defect is structurally invisible to all of them, because
**no test crosses the web↔server boundary**: both ends are tested and each fakes the other. A
feature that has never worked on any boot shipped green (#249).

The cost is not missing coverage. It is that nobody can say which claims the green covers,
and a reader cannot tell a test that *could* fail from one that *cannot* — this repo has
both. Whoever inherits this trusts green, ships a 401, and had no way to know.

## Evidence

- **#249, the anatomy.** `POST /api/label` requires `x-rhizomorph-capability`; the token is
  minted in-process (`build-app.ts:67`) and reaches no web surface. Both ends are green anyway:
  `api/label.test.ts:52` manufactures the header from `app.capabilityToken`, a value the browser
  cannot read; `RenameControl.test.tsx:26` injects a fetch double returning 200 unconditionally.
  No web file references `buildApp`, none imports server source, no `e2e/` exists. One Fastify
  `inject` test on the real `requestLabel` catches it.
- **A law whose walk is narrower than its claim** (2026-08-07 audit finding 2, High, PR #280).
  `lab/no-live-fleet-law.test.ts:36-40` walks `lab/` flat — 5 of 17 files — so the vacuity guard
  added for exactly this risk (`toBeGreaterThan(3)`) passes on the 5 it sees, while
  `lab/branching/geometry.ts:1` already imports `../../scene/palette.js`, the import the law
  forbids: invisible twice, since the pattern is hardcoded one level up too. Two siblings share
  the flat walk (`recordings/`, `drawer/`).
- **Tonight's two-seat adversarial review** of five green PRs (#282–#286) confirmed fourteen
  defects the suite could not see; two are this PRD's subject. A hostile `instance: "__proto__"`
  crashed a fold — `byInstance['__proto__']` returns `Object.prototype`, so `?? []` never fires
  and the spread throws (`core/src/state.ts`, PR #283). And a stated-precondition test in
  `selectors/spend-cursor.test.ts` **could not fail**: its dedup arrived sessionlog-first, the
  ordering where the fold's own winner-selection rewrites nothing. Its fix was a companion
  assertion — *"the dedup this test relies on really does rewrite a value."*
- **Green is platform-scoped.** `ci.yml:20,158` runs ubuntu + macOS only; a Windows-native run
  carries ~130 pre-existing failures no leg covers, and #281 says it plainly: *"No CI leg can
  witness this fix."* A failed `Test` step also skips typecheck, lint, the packaging guard and
  the boot smoke on that leg (`AGENTS.md`) — a red leg is four unrun gates. Coverage is
  unmeasured (#244), so the account above is read, not measured.

## Success

- Each mismatch class that shipped — **header, status, body shape, route path** — has a test
  that goes red when the contract breaks, proven by breaking it: rename the header in the
  server, and exactly that test fails.
- Every law's **walked scope is mechanically equal to its claimed scope**: a file added
  anywhere under a governed root is checked, or turns the law red.
- Every new law or regression test lands **shown red against the pre-fix tree**, in the PR.

**Not met while** any `MUTATING_MODULES` entry has no contract test; while any law's
vacuity floor is a hardcoded literal rather than derived from its walk; or while a claim
that the suite is green omits the platforms it was green on.

## Non-goals

- **No browser or E2E harness** — no Playwright, Selenium, WebDriver. Rejected on the repo's
  own terms: every gate here is a deterministic oracle over injected fakes, and a browser
  adds sockets, ports, a downloaded binary and timing. It would be the slowest, flakiest gate
  here and a tax the cohort cannot carry — and would not have caught #249 a day sooner than a
  20-line `inject` test.
- **Not a coverage threshold.** #244's meter is adopted and its number published; a gate before
  the canvas is ruled buys tests written to touch code jsdom cannot run.
- **Not a suite rewrite or prune.** #218 owns classification and shape-test pruning: the suite
  as a second implementation, not as a false witness.
- **Not the Windows gap** (#277 owns the pass, #281 its first defect) — only that green state
  its scope. And **no new laws over ungoverned directories** (`lab/compare/`, 7 files):
  widening what a law *claims* is separate from making its walk equal it.

## Rulings

## Ruling 1 — contract tests drive the real client against the real `buildApp`

A private `packages/contract/` project calls `buildApp(ctx)` and hands the **real** web client a
`fetch` backed by `app.inject`. The load-bearing property: method, URL, headers and body come
from the web module, never from the test — the exact property `api/label.test.ts:52` lacks.
Rejected: either existing project (jsdom vs node environments), cross-package relative imports
(`@rhizomorph/web` is `private`, no `exports` map), and the harness above.

## Ruling 2 — the requirement to have a contract test is itself a law

`MUTATING_MODULES` already enumerates the three clients crossing the seam; a law asserts each
has one, and the read side joins by **declared enumeration, not ambition** — a named list
where adding a seam module without a contract test fails.

## Ruling 3 — a law's walked scope is derived from what it claims, never hardcoded

Recurse from the claimed root (proven at `mutating-calls-law.test.ts:71-88`), make patterns
depth-independent (`/from ['"](?:\.\.\/)+scene\//`), and replace every magic floor with an
assertion that the walked set **equals** that root's recursive source listing. This forces
`geometry.ts`'s palette import into the open as a carve-out or a violation — a decision a human
owes, and one this ruling surfaces, not settles.

## Ruling 4 — an assertion that cannot fail is a defect, at the severity of a wrong one

Two cheap mechanisms: every law or precondition test carries a **companion assertion that the
condition it observes is actually present** (the pattern tonight's spend-cursor fix invented),
and a **falsification requirement** — a new law or regression test is shown red against the
pre-fix tree, in the PR body.

## Ruling 5 — mutation testing is scoped to the folds and the laws, never the suite

#218 asks for a score on a representative subset; this rules *where* the runtime is worth paying
— `reduce.ts` / `state.ts` and the law tests themselves, where a surviving mutant means a law has
no teeth. Rejected: whole-suite mutation, a multi-hour job nobody runs twice, whose score would
be dominated by tests #218 intends to delete.

## Ruling 6 — "green" states its platform scope wherever it is claimed

CI is ubuntu + macOS; a Windows-native run is not green and no leg says so. Until #277 produces
evidence, every claim that the suite passes names the platforms it passed on. Whether Windows
becomes a CI leg is gated on #277 and is the leads'.

## Sequencing (waves, each gated as ever)

1. **Keystone:** `packages/contract/` plus the `/api/label` contract test — already #249's
   own "Done when", so it lands there. Then `/api/rotate` and `/api/lab/launch`
   (**unfiled:** one issue for those two, one for Ruling 2's law).
2. Parallel, fenced apart: **#233** adopted — a law holding a raw-compare copy is this family's
   smallest instance, and it is already fenced, so adoption reframes it rather than delays it.
   Beside it, **unfiled:** recursive walks, derived floors and depth-independent patterns across
   `lab/`, `recordings/` and `drawer/`, carrying the `geometry.ts` carve-out (audit findings 2,
   9, 13 — one issue, because they share one decision).
3. **#244** for the meter only; **#218** for Ruling 5's scope only. **Unfiled:** the
   platform-scope wording sweep for Ruling 6.

## Open questions

- Whether the contract oracle covers the read seam (`/api/meta`, `/api/sessions`, the SSE
  stream) or stops at the three mutating clients. Open, not ruled.
- Whether a new workspace boundary needs an ADR — a lead's call, not this PRD's.
- `vite dev` serves `index.html` itself, so a token delivered at serve time is absent in
  dev — an `inject` oracle cannot see that. Named, not ruled.
- Whether Ruling 4's falsification requirement is practice or mechanised, and whether Ruling 5's
  narrow run enters CI or stays a number on #218. Both a lead's call, as is whether the ~130
  Windows failures are one defect or many — unknown until #277.
