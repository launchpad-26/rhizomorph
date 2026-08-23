# prd-43 — the claim is a test: a document's factual claim fails the build when it goes false

> **Status:** **BLESSED** — Ciaran Slow, 2026-08-22, in session. Milestone `prd43`. Drafted the same day from the reconciled audit
> at `03df141` (findings 11, 13, 15, 17, 18, 29, 30, 31, 40 — untracked artefact, `.gitignore`d;
> the sha is the anchor).
> Finding 30 needs an **ADR** before its prose is corrected —
> the divergence it names is prd-12's, and a shipped PRD cannot be edited in place.

## Problem

This repo's documents make checkable factual claims: a path exists, a count is nine, a platform
is unverified, a grep returns nothing, a subcommand exists. Those claims are load-bearing —
`README.md` is a trust document by prd8's ruling, and `SECURITY.md` is where a reader learns
where the fence is.

Every one of them drifts, because nothing checks any of them. The audit found four clusters of
dead paths, a route count that is wrong in three files at once, a support matrix contradicted by
CI on every push, a "verify this yourself" recipe that fails on first run, a shipped subcommand
documented nowhere, and a screenshot-hygiene law that exempts the file type most likely to leak.

The pattern is one thing, not nine: **prose without enforcement drifts**, and this repo has
already proved it can enforce prose — `runbook-delivery-law` and `adr-log-law` do it today.

## Evidence

- **Four dead paths in `architecture.md`.** `:111`, `:227`, `:346` cite
  `packages/web/src/fleet/buildFleet.ts`; `:314`/`:330` cite `fences.ts`/`fences.test.ts`;
  `:2070` cites `packages/web/src/panels/spend/format.ts`. Verified: all absent;
  `buildFleet` now lives at `packages/core/src/fleet/buildFleet.ts` (moved by `#246`).
- **The roadmap says the lab has no UI.** `docs/roadmap.md:88`: *"Engine only; nothing in
  `packages/web/` reaches it yet"* — while `git ls-files packages/web/src/lab` returns **32**
  tracked files, including `LabPage.tsx`.
- **Four source files cite a deleted research note.** `core/src/events/judge.ts`,
  `collectors/judge/collector.ts`, `judge/mergetree.ts` and `judge/symbols.ts` all cite
  `docs/research/2026-08-04-semantic-judge-spike.md`, removed by `756e1bf` — whose own sweep
  covered documents citing documents, not code citing documents.
- **Three design-notes carry four links to a directory that does not exist**
  (`docs/decisions/`); the targets live under `docs/design-notes/` itself.
- **The route count is wrong in three places at once.** `README.md:99` says "three hands" where
  ADR-0019 adds the concierge as a fourth; `SECURITY.md:135` and `mutation-guard.ts:100` say
  "nine routes, five gated" where `api/index.ts` declares ten with six gated —
  `POST /api/retarget` is uncounted. `SECURITY.md` also describes two route classes where
  `ROUTE_CLASSES` now holds four, and never mentions the read gate prd-29 wave 1 shipped.
- **The support matrix contradicts CI.** `README.md:297` calls macOS *"Unverified… nobody has run
  it on macOS"*; the latest run on `main` has three green macOS legs including the `pack-smoke`
  that installs the tarball and runs the CLI. `AGENTS.md:294` calls that leg the one carrying
  path-shape signal.
- **The "verify yourself" recipe fails on first run.** `README.md:288-289` tells the reader to
  grep for `fetch(` and find nothing; there are **8** occurrences across 6 modules. All target
  loopback, so the claim holds and the recipe does not — and the recipe is the whole value.
- **A shipped subcommand is undocumented.** `rhizomorph export-otlp` exists in `cli/index.ts`
  and appears nowhere in `README.md`, while `CHANGELOG:14` makes the CLI surface the
  breaking-change contract.
- **The dead install URL, eight live sites.** `package.json` ×3 (`homepage`, `repository.url`,
  `bugs.url`), `README.md`'s clone command and its macOS issue link,
  `docs/user-guide/getting-started.md`, `docs/demo.md`. `gh repo view KelliherL/rhizomorph`:
  *"Could not resolve to a Repository"*. The app manifest's identical field is already guarded by
  `packages/app/src/host/manifest-law.test.ts:57`; the published root manifest is not.
- **Screenshot hygiene is exempted, not enforced.** `no-personal-paths-law.test.ts` skips every
  `.png` via `BINARY_EXTENSIONS`. All 16 tracked images are clean today, but
  `scripts/dev/visit.mjs` accepts `--repo <path>` and the MAIN drawer renders the watched path,
  so one capture against a real tree carries a home directory past every gate.

## Success

1. A dead path in a document fails the build. **Not met while** any `packages/**` path cited from
   an in-scope document, or from a source comment, can stop existing without a red suite.
   In-scope is `docs/**` *minus* the dated-artefact directories ruling 1 excludes
   (`docs/research/`, `docs/review/`, `docs/prds/`) — a criterion written over all of `docs/**`
   would be permanently unmet by design, since those directories are meant to hold paths that
   have since moved.
2. A count stated in prose is derived, not typed. **Not met while** the route counts in
   `SECURITY.md`, `README.md` and `mutation-guard.ts` can drift from `ROUTE_CLASSES`.
3. A platform the README calls verified is a platform CI runs. **Not met while** the support
   matrix and the CI matrix can disagree.
4. A recipe the README hands the reader returns what the README says it returns. **Not met while**
   any "verify this yourself" command produces output the surrounding prose denies.
5. The CLI surface and its documentation are the same list. **Not met while** a subcommand
   registered in `cli/index.ts` is absent from the README, or vice versa.
6. The install identity has one source. **Not met while** more than one tracked file names the
   repository URL independently.
7. A tracked screenshot cannot carry a real path. **Not met while** `.png` is exempt by
   extension rather than checked by provenance.

## Non-goals

- **Not a documentation rewrite.** Every fix here is a correction to a claim that is false, or a
  law that keeps it true. Nothing is restructured, and no prose is improved for its own sake.
- **Not the trust boundary's wording.** The *counts* are this PRD's; whether four `/api` reads
  stay tokenless is prd-29's ruling, and `SECURITY.md`'s sentence about them waits on it. This
  PRD fixes arithmetic, not policy.
- **Not `docs/research/`, `docs/review/` or `docs/prds/`.** Those are dated artefacts describing
  the tree at a commit — a path that has moved since is a true record, not a defect. The citation
  law excludes them by directory, deliberately.
- **Not prd-12's divergence itself.** Finding 30 (README misstates where lab sessions live) is a
  real implementation divergence from prd-12 ruling 1, and the ADR comes first. The README edit is
  downstream of that record, not a substitute for it.
- **Not the PRD paper backlog.** The roadmap's missing sixteen entries, the four PRDs that pass
  every criterion while reading `proposed`, and the `prd15 ruling 15` mis-cite are the PRD
  corpus's own hygiene and belong to a separate paper PR — not to a law about `docs/**` paths.

**Rejected alternatives.** *A link checker in CI over rendered HTML* — it needs a network and a
renderer, catches only anchors, and cannot see a path inside a code comment, which is where four
of these live. *Removing the claims instead of enforcing them* — the recipe and the support
matrix are load-bearing for a stranger's trust; deleting them is cheaper and makes the document
worth less. *One law over every markdown file* — `docs/research/` and `docs/review/` would go
permanently red for being accurate historical records, and a law that must be suppressed to pass
teaches its readers to suppress it.

## What already exists (do not rebuild)

- `runbook-delivery-law.test.ts` and `adr-log-law.test.ts` — this repo's own worked examples of
  a grep law over real `git` output that proves its own detector bites. The citation law follows
  their shape exactly, including the "half the tests exist to prove the probe works" discipline.
- `no-personal-paths-law.test.ts` — its `git ls-files` walk, its allowlist-honesty test and its
  trailing-punctuation handling are all reused. Ruling 4 replaces one exemption, not the law.
- `packages/app/src/host/manifest-law.test.ts:57` — already pins the app manifest's homepage.
  Ruling 3 derives every other site from it rather than adding a second assertion.
- `route-class-law.test.ts` — already walks the real Fastify routing table. Ruling 2 extends it to
  compare prose counts against `ROUTE_CLASSES`, rather than writing a new walker.

## Rulings

## Ruling 1 — a path cited from a document or a comment must exist

One law extracts every `packages/**`, `scripts/**` and `docs/**` path string from `docs/**/*.md`
**and from `packages/**/*.ts` comments**, and asserts each exists.

Scope is by what a file *is*, not what it is called: `docs/research/`, `docs/review/` and
`docs/prds/` — the whole PRD tree, not only `done/` — are excluded as dated artefacts, matching
this PRD's non-goal exactly. A PRD's Evidence section names dead paths **on purpose**: this
document's own lists four (`buildFleet.ts`, `spend/format.ts`, the semantic-judge note,
`docs/decisions/`), so a law that read live PRDs would go red on the document that commissioned
it. Excluding `done/` alone was the earlier, incoherent draft of this scope.

The exclusion list is itself asserted non-empty and honest — every excluded directory must
contain at least one path that would otherwise trip the law, or the exclusion is stale and hiding
a live file. That is the `#649` lesson applied to the guard rather than to the fixtures.

Code comments are in scope because that is where four of these findings live, and where the
`756e1bf` sweep stopped.

## Ruling 2 — a count stated in prose is derived from the thing it counts

`route-class-law.test.ts` gains a test that greps `SECURITY.md`, `README.md` and
`mutation-guard.ts` for the route counts they state and compares them to `ROUTE_CLASSES`. A
mismatch is a red build.

The same shape covers the support matrix: each platform `README.md` names as verified must appear
in `.github/workflows/ci.yml`'s matrix, and each platform in the matrix must appear in the table.
Prose that states a number about the code is a claim, and a claim is a test.

## Ruling 3 — the install identity has exactly one source

`manifest-law.test.ts` is widened to the root `package.json`'s `homepage`, `repository.url` and
`bugs.url`, and every other tracked mention of the repository URL is asserted to match it. The
app manifest's guard was correct and its sibling one directory up was unguarded — the shape
`AGENTS.md` names first, and the fix is to make one file the source rather than to correct eight
copies.

## Ruling 4 — a tracked screenshot is checked by provenance, not exempted by extension

The `BINARY_EXTENSIONS` exemption for `.png` is replaced. Every tracked PNG must be accompanied by
a sidecar manifest recording the synthetic root it was captured against, and `scripts/dev/visit.mjs`
strips real paths in capture mode. A PNG with no manifest is a red build.

This is the one ruling here that changes behaviour rather than prose, and it is included because
the alternative is a law that will be true until the first time it matters.

## Ruling 5 — a README recipe is executed by the suite

Where the README hands the reader a command and states its result, the suite runs that command and
asserts the stated result. The `fetch(` recipe is corrected to state the real count and the
loopback argument, and then pinned.

A recipe the reader cannot run costs exactly what a false claim costs, and it costs it at the
moment the reader was trying to extend trust.

## Sequencing (waves, each gated as ever)

`docs/**`, `README.md`, `SECURITY.md`, `CHANGELOG.md` and the law tests are this PRD's territory.
`docs/prds/**` is the PRD corpus's own; no wave here edits a PRD. `api/index.ts`'s route classes
are prd-29's — this PRD reads `ROUTE_CLASSES`, never writes it. Every wave follows prd-39 wave 1.

**Wave 0 — operator act, booked not skipped.** The ADR recording prd-12's divergence (finding 30)
is written and merged. Not dispatchable: it is a ruling about a shipped constitutional amendment.

**Wave 1 — the Keystone.** `prd43 w1: a path cited from a document or a comment must exist`
(ruling 1). Lands **red**, naming all four clusters, before any of them is fixed — prd-24's
discipline, and the only way to know the law bites. Zero-claimant; every later wave consumes it.

**Wave 2 — parallel, fenced apart:** `prd43 w2: architecture.md points at the paths that exist`
(`docs/architecture.md`) · `prd43 w2: the roadmap says the lab has a UI` (`docs/roadmap.md`) ·
`prd43 w2: the judge's rationale is reachable` (four `packages/**` files + possibly restoring the
note from `756e1bf^`) · `prd43 w2: the design-notes link to where their targets live`
(`docs/design-notes/`).

**Wave 3 — parallel, fenced apart:** `prd43 w3: the install identity has one source` (ruling 3,
`manifest-law.test.ts` + the eight sites) · `prd43 w3: a tracked screenshot names the root it was
captured against` (ruling 4, `no-personal-paths-law.test.ts` + `visit.mjs`) · `prd43 w3: the CLI
surface and the README are one list` (`README.md` + a law over `cli/index.ts`).

**Wave 4 — after prd-29's ruling, because its wording depends on it.** `prd43 w4: the route counts
are derived from ROUTE_CLASSES` (ruling 2) · `prd43 w4: the support matrix and the CI matrix
agree` · `prd43 w4: the README's recipes are run by the suite` (ruling 5).

**Wave 5 — the sweep, last.** `prd43 w5: the README states where lab sessions live` — downstream
of wave 0's ADR, and last because it is the one correction whose *content* is decided elsewhere.

**Unfiled work implied, described not numbered:** the audited clone's `origin` still points at the
pre-rename `launchpad-26/rhizomorph.tmp`, working only through GitHub's redirect. That is local git
config, not a tracked file, so it has no issue — but it belongs in the operator's own checklist
beside ruling 3.

## Open questions

- **Restore the deleted research note, or inline its rationale into the four files?** Restoring is
  cheaper and keeps the citation resolving; inlining removes a dependency on a dated artefact.
  Open, not ruled.
- **Does the citation law belong at repo root or under `packages/server/`?** The root vitest
  config globs `packages/*`, so a root-level test would never run — the trap
  `runbook-delivery-law` and `no-personal-paths-law` both document. The answer is probably
  "beside them", but it is a placement nobody has ruled. Open, not ruled.
- **Should `docs/prds/` be excluded from ruling 1?** A PRD citing a path that later moved is
  arguably a dated record like a research note, and arguably a live document that should stay
  true. The corpus is cited 1,136 times from code, which argues for keeping it true. Open, not
  ruled.
