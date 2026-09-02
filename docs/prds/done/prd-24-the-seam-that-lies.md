# prd-24 — the seam that lies: what the suite is allowed to prove

> **Outcome:** superseded 2026-08-24 — the audit retires with every residual given a named
> home (see the closing amendment): prd-39/41/43 own the programme it seeded, prd-29 wave 3
> owns the read-side contracts, and two small fixes are described for the next groom.
> ADR-0026 supersedes this proposal's blanket Playwright rejection. Reconciled 2026-08-22 at
> `03df141`; lives in `done/`.

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

## Amendment — the browser oracle is no longer categorically excluded (reconciled 2026-08-22)

ADR-0026 subsequently adopted Playwright, and the repository now carries it as a root
development dependency. The Non-goal above is retained as the proposal's historical argument,
but its categorical rejection no longer governs future work. This does not silently expand this
PRD into an end-to-end rewrite: any browser-backed oracle follows ADR-0026's scope and still has
to prove which contract it witnesses.

## Amendment — the audit closes, its residuals re-homed (operator, 2026-08-24)

Retired as superseded on the retained-PRDs review's recommendation, against the tree at
`9a26030`. The programme this audit seeded is now owned by prd-39 (the landing gate's own
checks), prd-41 (laboratory laws) and prd-43 (document claims as tests); much of the rest
shipped here — and the tree has moved past the review in one place already: the `lab/` and
`drawer/` law walks are recursive today. Every remaining residual has a named home:

1. **DISCHARGED by the tree (verified 2026-09-02, #215).** This residual read: *the
   recordings law still walks one directory level* (`web/src/recordings/no-live-fleet-law.test.ts`,
   flat `readdirSync`), described for the next groom as one small issue. It is fixed.
   That file now walks recursively through `walkSourceFiles` — the shape
   `lab/no-live-fleet-law.test.ts` proved out — and computes its non-vacuity floor from a
   separate recursive `readdirSync` in `realSourceFileNames()` rather than from a
   remembered literal, so the expectation moves with the tree. A nested fixture is
   committed under `recordings/recursion-fixture/`, which means the recursive branch is
   exercised by the tracked tree rather than only in principle.

   The two further walks this residual named are **still flat**, and still latent rather
   than live: `interaction/no-model-call-law.test.ts` and `connect/index.test.tsx` both use
   a single-level `readdirSync`, and both directories contain **zero subdirectories** today.
   That is the same "latent, not live" state `recordings/` was in when #44 landed. They are
   recorded here as known, not groomed — the day either directory grows a subdirectory,
   its law goes quietly vacuous.
2. **DISCHARGED by the tree, and better than proposed (verified 2026-09-02, #215).** This
   residual read: *CI stops producing evidence after a red Test — no `if: always()` on
   Typecheck, Lint, the packaging guard or the boot smoke, so a red leg is four unrun
   gates.* All four now run. `Typecheck` and `Lint` carry `if: "!cancelled()"`; the
   packaging guard and boot smoke carry `if: "!cancelled() && steps.build.outcome ==
   'success'"`.

   The difference from what this residual asked for is deliberate and is the better answer:
   `always()` was **rejected** on the grounds that the packaging guard flags only unexpected
   files and so passes vacuously over an empty `dist/`, while the boot smoke's bin falls
   back to TS source when `dist` is absent — so on a Build-red leg `always()` would report
   both green having verified nothing built. `AGENTS.md` carried the stale claim for as long
   as this residual did, and #215 corrects both together.
3. **The read-side contract policy** — owned by **prd-29 wave 3** since its 2026-08-24
   ruling: the read axis joins `packages/contract/`'s coverage law by declared enumeration,
   gated on #428 as prd-29's sequencing says. The `vite dev` token blind spot named in the
   open questions above is the same dev-mode question prd-29 and prd-23 carry; whoever rules
   it there rules it for the oracle too.
4. **Falsification stays practice; mutation testing stays parked.** Ruling 4's
   shown-red-in-the-PR discipline and companion assertions remain working practice backed by
   AGENTS.md's review questions, not a mechanism; ruling 5's scoped mutation run is
   deliberately unbuilt until someone brings evidence the practice is failing. The
   `geometry.ts` carve-out ruling 3 surfaced remains a decision owed by whoever grooms the
   walk sweep.

Ruling numbers here stay citable forever; nothing is renumbered by retirement.
