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
- **The roadmap said the lab has no UI.** `docs/roadmap.md:88` read *"Engine only; nothing in
  `packages/web/` reaches it yet"* — while `git ls-files packages/web/src/lab` returns **32**
  tracked files, including `LabPage.tsx`, rendered from `App.tsx:129`. It also contradicted
  prd14's own entry eight lines below, which already called that console live. **Corrected in the
  paper PR that blessed this PRD**; retained here because the shape is the point — two entries in
  one file disagreeing about whether a feature exists is exactly what nothing was checking.
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
a sidecar manifest that records the synthetic root the capture ran against **and the SHA-256 of
the image bytes it describes**; the law recomputes that digest and fails on a mismatch. A PNG with
no manifest, or with a manifest whose digest names different bytes, is a red build.

The digest is what makes the sidecar evidence rather than an assertion. Without it a manifest
declaring `/Users/operator` sits happily beside a PNG rendered against a real home directory, and
the law passes while the leak ships — no grep can read a path drawn into pixels. Binding the pair
is necessary and not sufficient, so the second half of the ruling carries the rest:
`scripts/dev/visit.mjs` gains a capture mode that substitutes the synthetic root **before** the
screenshot and emits the sidecar itself, and it is the only sanctioned way to produce a tracked
PNG. A hand-made capture cannot produce a valid pair, which is the point — provenance is enforced
by the tool that has the root, not by a human remembering to declare one.

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

**Amended 2026-09-04 — wave 5 is stranded, and the order out of it is forced.** `#235` is
blocked by `#220` (prd-30 **wave 3** — the `title=` adoption sweep; prd-30's own Sequencing
lists it as item 3 and its amendment says "the sweep is `#220` as one issue", so do not copy the
"w1" that `#235`'s own body carries), which has no branch, no worktree and sits at Soon/Backlog: so
wave 5 waits on another programme's issue and `#24` is effectively a one-issue wave. `#24` is
otherwise dispatchable — PR `#250` closed and freed `README.md`, and wave 0's ADR-0032 landed. It
is deliberately NOT re-waved to bundle elsewhere, because `#24` and wave 6's `#234` both claim
`README.md` (fence lint: OVERLAP), so they can never be in flight together whatever wave they
carry. That forces a sequence rather than a bundle: land wave 6's second PR, then `#24`, or the
reverse — never both.

**Amended 2026-09-03:** wave 5 holds two issues, not one. `prd43 w5: a law's file-count comment
and its assertion say the same thing` was filed into it deliberately (its residual is recorded in
prd-41), and it is blocked on `#220` rather than on wave 0. The README exclusivity still holds —
it claims two lab law tests and never `README.md`.

**Wave 6 — the enforcement residue, and the first wave this PRD did not plan.** Waves 1–5 fixed
the documents ruling 1 and ruling 2 name. Reviewing that work produced a second class: places the
*laws themselves* are narrower than the rule they enforce, and documents the sweep never reached.
That is not scope creep, it is what a law finds once it exists, and it belongs to this PRD rather
than a new one — the `charter-laws` carve-out (2026-09-02) is explicit that where a live PRD owns
the territory the issue is that PRD's, however awkward the fit.

Fence-disjoint, verified with `scripts/fence-lint.sh` rather than asserted, so all of these may be
built at once:

- `prd43 w6: every route count this repo states in prose is swept by one law` (#232) — ruling 2's
  sibling sweep. Two of its eight sites are **wrong today**.
- `prd43 w6: a separator alone makes a remedy token a path claim` (#231) — ruling 1's own law is
  narrower than its stated rule.
- `prd43 w6: docs/demo.md and the shell agree about Esc` (#225) — a document stating the opposite
  of `PanelGrid.tsx`. Decides which text is right and fixes the document only; if the answer is
  "the shell should handle Esc", that is a shell issue with its own boundary.
- `prd43 w6: a tracked screenshot is bound to the tree it depicts` (#226).
- `prd43 w6: watching.md's gap list states its real provenance` (#233) — wants a judgement first:
  enumerate the voices, or say the list samples them. Do not add a law before that is ruled.

**Stacked behind, not parallel:** `prd43 w6: the outbound sweep's vocabulary covers three more
spellings` (#234) claims `route-class-law.test.ts`, which #232 holds. It is three lines once #232
lands.

**Joining wave 6 when filed:** the corrections downstream of ADR-0032 — `README.md`'s Trust
section naming the wrong location for lab artefacts, ADR-0005's narrowed root claim, and the
containment law's silent `claude-projects` clause. Filed after the ADR lands so the issue can cite
it rather than a branch.

**Joined wave 6 after the fact (amendment, 2026-09-04).** `prd43 w6: the route-count completeness
sweep fits its timeout on the slowest runner` (#266) and `prd43 w6: the sweeping tests have a
budget they can actually meet under load` (#270) are the same defect — the completeness sweep in
`route-class-law.test.ts` timing out on vitest's 5000 ms default — filed twice within hours and
built twice in parallel, by two sessions that could not see each other's lane.

They belong to wave 6 because `#234` claims the same file, and because wave 6's gate could not go
green without them: its red was `#266`, measured at 4.54 s with the wave applied against 4.78 s on
plain `main`, so the wave was never the cause.

**Why they were not bundled in the first place, which is the part worth keeping.** Both were filed
with no wave — `prd43:` and `route-class-law:` respectively. The bundle unit is (milestone, wave),
so an issue carrying a milestone and no wave is structurally unbundleable and becomes its own PR
before anyone decides anything. Nothing caught it: `issues.sh orphans` checks milestone and board
membership, and answered "all open issues carry a milestone" — true, and useless here, which is
the same shape that command's own history already records. Both were retitled into wave 6 on
2026-09-04.

**The fold caught one of the pair, not both, and that is the durable part.** `#266` landed on its
own as PR `#269`, merged 2026-09-04 21:30 from the other session — about fifteen hours after wave
6's second PR was opened carrying a byte-identical fix for it. So a bundling rule enforced at the
issue level did not prevent the same collision one level up, where nothing was checking: two PRs,
not two issues. It cost nothing here, because the duplicate commits were patch-identical: the
review merge of `main` into this branch (`3e4dd93`) reconciled all three conflicts, every one of
them this branch's `SWEEP_TIMEOUT_MS` superseding main's `30_000` literals. `#270` is the half the fold did keep, and it was not
redundant — `#266` raised the budget on two of the three sweeping tests and left the third, `the
completeness sweep reads a non-empty file set`, on the 5000 ms default while calling the same
`sweptFiles()`. Its branch is superseded by the fold rather than landed on its own, and its fix —
one `SWEEP_TIMEOUT_MS` held by all three — survives inside it.

**Wave 7 — ruled 2026-09-04, and it is two issues, not one.** `#66` (the docs cite a tracker
that no longer exists) was booked the way wave 0 is booked: an operator act, not dispatchable
until ruled.

> **SUPERSEDED 2026-09-06** — by *"Wave 7 gained `#264`"* below, which corrects the count to
> three. Kept in place because citations to this paragraph must keep resolving, and because the
> ruling it records about `#66` and `#261` is still the ruling. Only the count is wrong here.
> Flagged by `scripts/dev/prd-reconcile.sh 43` as DOUBLE-DECLARED after the amendment landed in
> PR #284 — the amendment declared wave 7 a second time and did not mark this one, which is the
> defect the reconciler exists to catch and which no reviewer caught before the merge.

The ruling is made and recorded on the issue — **a single dated note in `AGENTS.md`
and `docs/prds/README.md`**, with the 216 references in the other 110 files left untouched. A
per-reference marker across 111 files and a mapping to surviving artefacts were both considered
and rejected: the first is a 216-edit diff nobody can review whose per-site markers rot when the
corpus moves, the second is only partially recoverable. `#66`'s fence is now groomed to those two
files.

The evidence below argued that a note alone is the *weaker* half, and the ruling agrees with it
rather than overriding it — which is why wave 7 gained a second issue. **`#261` (a citation above
the live maximum cannot enter the corpus)** is the guard, filed 2026-09-04 and fence-disjoint from
`#66` (`packages/server/src/doc-citation-law.test.ts` plus a baseline file, against `#66`'s two
documents), so the two share the wave and its PR: one writes the note that explains the existing
citations, the other writes the law that stops more arriving. `#261` is **blocked by `#241`**,
which holds `packages/server/src/doc-citation-law.test.ts` and is in flight — dispatch the pair
once it lands.

Why `#261` is a separate issue rather than a clause of `#66`: the naive form of that law fails
immediately on all 216 existing references, so how it tolerates them — a committed baseline in the
`.windows-known-failures` style, or a predicate scoped by document date — is a design decision
with a rejected alternative to name. `#66`'s own Definition of done calls the guard "worth
considering" and stops short of ruling it, correctly.

**One constraint the original text could not have known, and it invalidates the obvious wording.**
`#66` was measured on 2026-08-25, when the highest number that had ever existed in this repository
was 64. **Measured again 2026-09-04**, because that figure expired: this repo's sequence began at 1
on 2026-08-21 and had reached **262**, while the prior tracker's citations in this corpus reach
**655** — so **the two sequences overlap and no numeric threshold separates them.**

Both figures are given as a dated measurement rather than as current fact, deliberately. The first
draft of this paragraph typed "260" and was stale before it was pushed — `#261` already existed
five minutes earlier, and `#262`, the PR carrying the paragraph, was opened a minute later. A
hand-typed live maximum in a document whose subject is that counts must be derived is the wrong
shape twice over.

The prior-tracker figure was hand-derived too, and it was wrong in the more instructive way. It
first read **674**, and 674 is not a citation at all: the sweep that produced it matched
`#674c63`, the `--color-paper-600` hex in `packages/web/src/theme/theme.css`, because the pattern
had no boundary after the digits. The highest genuine citation in this corpus is **655**
(`packages/web/src/app/shell-bounds-law.test.ts`), which is what two narrower sweeps had already
reported and what the wider one overrode. Derive it, do not read it off this page:

```sh
# 1-3 digits: this corpus's own tracker has never exceeded three. The only
# four-digit tokens present cite other projects (jupyter/notebook 1831, tmux
# 3064), and a sweep that admits them reports those instead. Re-check past 999.
# Note the sweep reads THIS file too: writing a hash-number token into the prose
# below moves the number the command returns.
git grep -hoE '(^|[^0-9a-zA-Z#])#[0-9]{1,3}([^0-9a-zA-Z]|$)' \
  | grep -oE '#[0-9]+' | tr -d '#' | sort -n | tail -1
```

Re-measure rather than trusting any of these numbers; the overlap holds at all of them. A note
claiming everything below 660 refers to a prior tracker would disown every live citation the
corpus has legitimately accumulated since August. The note states the ambiguity instead: above
the live maximum a citation is unambiguously
prior-tracker, at or below it the citing document's own date decides, and a sha is the durable
citation because the commits survived the recreation even though the issues did not.

Evidence for the ruling, gathered incidentally on 2026-09-03 and worth having before it is made:
writing ADR-0032 required citing `#148`/`#153` by sha because the commits survived the 2026-08
recreation and the issue numbers did not, and ADR-0005's own `#243` now returns *"Could not
resolve to an issue"*. **A dated note alone would not have helped**, because the cost fell on
*authoring* a citation rather than reading one — which is the case that keeps producing new dead
references. That argues the guard `#66` already suggests is the load-bearing half.

**Amended 2026-09-05 — wave 7 is three issues, and wave 8 exists.** Both drifts are the tracker
running ahead of this document; the document is the plan of record, so it is amended rather than
the issues retitled. `scripts/dev/prd-reconcile.sh 43` against `origin/main` at `5fa85b0` found the
second on its own and could not find the first, because it compares declared waves against claimed
waves and never counts the issues inside one — a wave that gains a third issue reads as reconciled.

**Wave 7 gained `#264`** — *ADR-0032 names the writer that actually writes, and the subject it
actually rules*. The paragraph above says wave 7 "is two issues, not one"; it is three. `#264` is
this PRD's own thesis turned on the PRD's own output: ADR-0032's body names
`packages/server/src/lab/checkpoint.ts` as writing synthesized sessions to the harness tree, where
the write is `synthesizeSession` in `restore.ts` — `checkpoint.ts` only ever `readFile`s that tree
— and it rules *checkpoints* where its subject is *sessions only*. EXECUTED during `#24`'s verify
pass: `captureCheckpoint` against a fixture repo, diffing both trees, produced **zero** entries
under the harness tree. The error had already propagated, which is why it is a wave-7 issue and
not a note — `#24` corrected `README.md`'s Trust section *from* this ADR and faithfully inherited
it, swapping which half of the sentence was false. It shares wave 7 rather than joining wave 6's
"joining when filed" list because it is fence-disjoint from both siblings (`docs/adr/0032-*.md`
plus `docs/adr/README.md`, against `#66`'s two documents and `#261`'s law plus its baseline), so
all three share the wave and its PR.

**Wave 8 is declared, and `#275` is its only issue** — *every row in the outbound-call table
states its real expected count*. It was filed carrying `w8` while this Sequencing declared waves
0–7, so `fence-lint` and the board both accepted an issue whose wave existed nowhere. Wave 8 is
the residue of ruling 2's sweep in the same sense wave 6 was of ruling 1: `#232` swept every route
count this repo states in prose, and **two of the eight sites it newly found were already wrong** —
`security.ts` said "ten" gated reads and `lane-index.test.ts` said "eleven", both against a true
fourteen. It folded those eight together with the four `#23` already guarded into one `CLAIMS`
table of twelve. `#275` is the same defect one table over.

The count in that sentence is stated carefully, because the first draft of it got the arithmetic
wrong in the way this PRD exists to catch: it read "two of the eight rows it then had", which
conflates the **eight sites discovered** with the **twelve rows the table then held**. Caught by a
review seat re-deriving it from `9f020e2` itself, not by any gate.

**And "no gate" is the precise claim, because the looser one is false and was caught the same
way.** The first wording said no test reads this file. It is excluded from the enforcement
sweeps — `EXCLUDED_DIRS` in the citation law and the route-count sweep both list `docs/prds/` —
but the citation law's *exclusion-honesty* control does read it: it globs `docs/prds/**/*.md`,
passes every file through `readSweptFile`, and asserts the directory **would** trip the law if
scanned, so that a stale exclusion cannot sit here unnoticed. This document is therefore read by
the suite and enforced by none of it, which is a narrower and stranger position than "unread", and
the two are worth telling apart. Two seats split on exactly this: one checked `EXCLUDED_DIRS`
membership and concluded the file was unread; the other ran the control and found it reading.

**`#275` is unblocked and still not dispatchable, and the reason is outside this PRD.** Its stated
blockers — `#234` and `#270`, both wave 6 — landed in PR `#272`. Its fence is a single file,
`packages/server/src/api/route-class-law.test.ts`, and **prd-17's `#276` claims that same file**;
that wave is assembled and unlanded, so the file is held. `dispatch-preflight.sh` does not catch
this, because it reads open PRs and prd-17 wave 2 has none yet. Land prd-17 wave 2, then dispatch
`#275` — and re-run `scripts/fence-lint.sh` rather than trusting this paragraph, which is the
instruction `#275`'s own body already carries about its previous blockers.

**Three closed issues in this milestone carry no wave:** `#215` (AGENTS.md's CI claims match what
the workflow actually runs), `#222` (the retained PRDs state what is true on main) and `#228` (a
citing document that declares the tree it is pinned to is a dated artefact). They are recorded here
rather than sequenced: all three are closed, so no dispatch can be affected, and back-filling a
wave onto finished work would invent a dependency layer that never existed. The cost was real
while they were open — `fence-lint` never saw them and the board's orphan check cannot tell a
missing wave from a present one — and that is the durable half: **a milestone plus no wave is
invisible to both guards this repo has**, which is the same shape the `#266`/`#270` pair recorded
above at the bundling level.

**Wave 9 — declared 2026-09-05, one issue, and it is the runbook half of an enforcement that
already exists.** `prd43 w9: the runbook states what a PR requires before it is opened` (`#285`).
`AGENTS.md` never states that a PR needs an independent review pass over every commit and the
operator's word for that specific PR: `grep -c '/verify' AGENTS.md` returned 0. The rule lived
only in a project memory and in the verify skill's own text, both of which load conditionally — a
session that never invokes the skill never meets the rule.

It belongs to this PRD rather than to `charter-laws` on that milestone's own test: the carve-out
is for a rule the **design charter** already states, and this is process, not design. It is its
own wave rather than joining wave 8 because `#275` is held behind another programme's fence and
would hold this hostage, and because the two share no file.

**It is fence-blocked by wave 7's own PR.** `AGENTS.md` sits inside `#66`'s fence, so `#285` and
wave 7 could never be in flight together. **That constraint is discharged**: wave 7 landed in
PR #284 (`547429d`), and the branch carrying `#285` was rebased onto `main` — it is no longer
based on the wave-7 head, and `git merge-base --is-ancestor` says so. Recorded rather than
deleted because the sequencing decision was real when it was made.

The failure that produced it is this PRD's thesis pointed at the PRD's own toolchain: on
2026-09-05 two commits were recorded with `verify-ledger.sh record --force`, and the ledger, the
PR-opening script **and** the PreToolUse approval guard then all reported the range verified.
Three layers that look independent were reading one exit status the session under review had
itself written. A bare `check` exits 0 on a forced row. The operator-side repair — a `--strict`
mode, and both callers using it — is not in this repo; `#285` is the half that is.

**Wave 10 — declared 2026-09-06, two issues, both enforcement residue found by reviewing wave 7
rather than by any gate.** Fence-disjoint, verified with the fence lint rather than asserted, so
they were built in parallel. **Built, reviewed over three rounds, and open as PR `#297`** — this
paragraph said "may be built at once" until 2026-09-07, describing as future work that had
already shipped, which is this PRD's own thesis pointed at its own Sequencing. A review seat
caught it, and the first repair pass then missed it while fixing the rest.

Round 1's findings are LISTED rather than counted, because counting them is what went
wrong: two seats reported separately, their findings were merged by total instead of by
identity, and one issue occupied a slot already counted. They were — the blockquote that
swallowed its own ruling, a stale ceiling claim, a false count of where the rule was
written down, a false claim in an earlier commit message, a stale "based on the wave-7
head", a missing operator-local clause, and this one. Derive the total from that list if
a total is wanted; do not carry one forward.

- `prd43 w10: a pinned sha is evidence only if it landed` (`#288`). `isPinnedArtefact` grants a
  document total exemption from the citation law when its `**Tree:**` pin "resolves", tested with
  `git cat-file -e` — the object store, not reachability. EXECUTED: a locally created, orphaned
  commit is reachable from no ref and still resolves, so a document can exempt itself with a sha
  that never landed. It is the sibling of the `--all` ceiling defect wave 7 spent two rounds on:
  local git state is not evidence that something landed. The corpus carries exactly one pinned
  artefact today and it is honest, so tightening the check costs no migration — which is why this
  is filed now rather than after a second pin arrives.
- `prd43 w10: every docs/prds exclusion proves it is not vacuous` (`#289`). Three sweeps exclude
  `docs/prds/`; only the citation law asserts the exclusion would trip if scanned, and it does so
  in two controls. Ruling 1 states that principle and the two later sweeps inherited the shape
  without the proof.

  **One of those two exclusions has ALREADY gone vacuous, which is why this is a defect and not a
  guard.** EXECUTED against the route-count law's own twelve production patterns, applied to all
  53 tracked `docs/prds/**/*.md` files: **zero matches.** Its exclusion hides nothing today, so an
  honesty control written for it would fail on its first run — the issue's subject is therefore
  the decision (retire the dead exclusion, or make it non-vacuous), not the guard. The
  manifest law's exclusion IS still doing work — `docs/prds/parked/prd-38-the-borrowed-credential.md`
  carries a real clone instruction its sweep would match — and is merely unproven.

  **The first draft of this paragraph said both exclusions were honest, and it was wrong.** The
  measurement behind it was a hand-written grep for route-count-shaped prose, which matched a
  sentence in this very PRD that the law's actual patterns do not match. A command that succeeds
  and enumerates something other than what was asked is the failure this PRD exists to catch, and
  it was caught by a review seat rather than by the author or by any gate.

**`#289` cannot be dispatched beside `#275`**: both claim the route-count law file, and the fence
lint calls that an OVERLAP whatever wave they carry — so it forces a sequence, exactly as wave 5's
`#24` and wave 6's `#234` did. An earlier draft also named prd-17's operator-door issue as a third
claimant; that issue closed with PR #286, whose merge was already an ancestor of this branch when
the claim was written.

**Unfiled work implied, described not numbered:** the audited clone's `origin` still points at the
pre-rename `launchpad-26/rhizomorph.tmp`, working only through GitHub's redirect. That is local git
config, not a tracked file, so it has no issue — but it belongs in the operator's own checklist
beside ruling 3.

## Open questions — all three RULED 2026-09-07

Ruled by the operator, and in every case practice had already answered them; what was
missing was the record. Each ruling below states the artefact that decides it, so a
later reader can check rather than trust.

**Ruling 6 — the deleted research note is RESTORED, not inlined.** Decided by `7070b20`
("restore the research notes…"), building on `caa6827`, which put
`docs/research/2026-08-04-semantic-judge-spike.md` back in the tree. The four source
files that cite it — `core/src/events/judge.ts`, `collectors/judge/collector.ts`,
`judge/mergetree.ts`, `judge/symbols.ts` — therefore resolve, and ruling 1's law is
green for a real reason rather than by exemption. Verified: the note is not in
`ALLOWLISTED_BROKEN_CITATIONS`, so nothing is suppressing it.

The rejected alternative was inlining each rationale into the four files, which would
have removed the dependency on a dated artefact. It was rejected in practice: restoring
keeps one source of the reasoning where four copies would drift apart, and the citation
law makes the dependency safe by failing loudly if the note is deleted again.

**Ruling 7 — the citation law lives beside the other laws, under `packages/server/`.**
It shipped at `packages/server/src/doc-citation-law.test.ts`. The question named the
reason itself: the root vitest config globs `packages/*`, so a root-level test would
never run — the trap `runbook-delivery-law` and `no-personal-paths-law` both document.
A law nobody runs is worse than no law, because its silence reads as a pass.

**Ruling 8 — `docs/prds/` IS excluded from ruling 1, as a CITING source only.** Shipped
as `EXCLUDED_DIRS = ['docs/research/', 'docs/review/', 'docs/prds/']`. The distinction
the question missed is the one that makes both halves right: a PRD's own citations are a
record of the tree at a commit and are not swept, but a path pointing INTO `docs/prds/`
from anywhere else is still a live claim and IS checked. Excluding by citing-file
directory rather than by cited-target directory is what keeps the corpus's 1,136
inbound citations honest while letting a PRD name a path that has since moved.

The cost is real and is recorded rather than hidden: nothing checks a PRD's own claims
about itself. Three false claims in this document were caught by review seats during
wave 9, and none could have been caught by a gate. `#289` is that gap one level down,
for exclusions rather than prose.
