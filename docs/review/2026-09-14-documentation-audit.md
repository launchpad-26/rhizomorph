# Documentation audit — 2026-09-14

**Tree:** `main` at `f4b7b57437bd066c0d6d08b0729189a871c405b8`
**Platform:** the figures below were measured on **native Windows**. Two of them
are platform-dependent and do not reproduce elsewhere; each gives the Linux
reading beside it. Nothing here was measured on macOS.

> A full sweep of this repository's documentation, commissioned by the operator
> 2026-09-14 alongside the decision to publish a generated wiki. **Findings only:
> this file changes no document.** Each fix is a separate fenced issue under the
> `docs-audit` milestone, named per finding below.
>
> Every claim is graded **EXECUTED** — a command was run and its output read — or
> **REASONED** — argued from the text with nothing run. The distinction is the
> point of the document; do not read a REASONED line as a measurement.
>
> This is a dated artefact: it records the tree at the sha above, not the tree
> today. Its own citations are a record, not a live claim.

## The headline: a law is green on a claim that is false

**F1 — The README's support matrix promises CI that has not run in two days.
EXECUTED.**

`README.md` lines 507–520 claim, for three platforms, verification on every push:

- Linux — "CI-verified on every push (`.github/workflows/ci.yml`)"
- macOS — "CI-verified on every push (`.github/workflows/ci.yml` runs build,
  suite, typecheck, lint and the boot smoke on `macos-latest`…)"
- Windows (native) — "`.github/workflows/windows-suite.yml` runs the full test
  suite on `windows-latest` at the current node on every push"

and, below the table, "CI pins that exact minimum" for the Node floor.

GitHub Actions has not run on this repository since 2026-09-12:

```
$ gh run list -R launchpad-26/rhizomorph --limit 50 \
    --json createdAt,conclusion \
    --jq '[.[]|select(.createdAt>"2026-09-12T06:00:00Z")]|length'
0

$ gh run list -R launchpad-26/rhizomorph --limit 3 \
    --json createdAt,workflowName,event,conclusion \
    --jq '.[]|"\(.createdAt) \(.workflowName) \(.event) \(.conclusion)"'
2026-09-12T00:29:16Z Windows suite pull_request failure
2026-09-12T00:29:16Z CI pull_request failure
2026-09-11T23:40:27Z CI push failure
```

Four commits landed on 2026-09-13 and 2026-09-14 and triggered nothing. The last
three runs before the silence all failed. Actions was retired for cost; the four
workflow files remain in the tree, and nothing executes them.

**F2 — The law that guards that section is green, and says so in its own test
name. EXECUTED.** This is the finding that matters more than F1.

`packages/server/src/api/route-class-law.test.ts` holds a support-matrix law.
Run on this tree, its substantive assertions pass:

```
✓ build-test-boot and pack-smoke both run ubuntu-latest — the Linux row
  claims CI, and CI delivers it
✓ README's macOS row cites both jobs' real shape: build-test-boot's
  macos-latest leg, and pack-smoke at both node legs
✓ README's Windows (native) row cites the leg that proves it
✓ the WSL row does NOT claim CI, because no workflow anywhere runs a WSL leg
✓ every platform row the table carries is asserted by name
```

A test named *"the Linux row claims CI, and CI delivers it"* is green while CI
delivers nothing.

The law is not broken. It compares README prose to the `ci.yml` **file**, and
both are intact; what moved is whether the file is ever executed. The law is
file-versus-file, and reality is neither file. This repo has shipped this shape
twice before — a gate that printed RED and merged anyway, and issues closed while
still held — and named it *reporting a check without honouring it*. This is the
same shape one level out: **checking a document against an artefact rather than
against the world.**

On **Windows**, the platform this audit ran on, that suite has one failure and it
is a known one: `windows-latest runs on pack-smoke and ONLY pack-smoke`, listed
in `.windows-known-failures` under cause class `line-endings`, whose stated
evidence matches the failure observed. **On Linux the file is 95/95 green.** A
reader reproducing F2 elsewhere should expect no failure at all — the green test
named above is green on every platform, which is the whole finding.

**F3 — CONTRIBUTING and AGENTS were updated for the retirement; the README was
not. EXECUTED.**

```
$ grep -c -iE 'ci-local|pr-verdict|Passed local CI' README.md CONTRIBUTING.md AGENTS.md
README.md:0
CONTRIBUTING.md:4
AGENTS.md:2
```

`AGENTS.md:451` records "GitHub Actions was retired for cost (2026-09-11)" and
names the replacement. `CONTRIBUTING.md:101-127` documents `scripts/ci-local.sh`,
`scripts/pr-verdict.sh` and the `Passed local CI` label. The README — the
document this repo's own coupling registry calls *"the trust document"* — has
none of it. The front door is the surface that went stale.

**F4 — One claim in AGENTS.md was left behind. EXECUTED.** `AGENTS.md:626` still
states that `.github/workflows/windows-suite.yml` "enforces per file on every
push". Same fact as F1, different file. It matters more here than in an ordinary
document because AGENTS.md is auto-loaded as the runbook by every agent working
in this repo.

## The citation exclusion is hiding 45 dead paths

**F5 — EXECUTED, with the law's own extractor.**

`doc-citation-law` excludes `docs/research/`, `docs/review/` and `docs/prds/` as
citing sources, on the reasoning that a dated artefact's citations record a tree
at a commit rather than making a live claim. That reasoning is sound for an
archived document and unsound for a live PRD.

Measured by emptying `EXCLUDED_DIRS` in a scratch copy, running the law, and
restoring the file (verified clean by `git status`):

| run | Windows (this audit) | Linux |
|---|---|---|
| unmodified tree | 15 | 0 |
| `EXCLUDED_DIRS` emptied | 60 | 45 |

**The columns agree on the finding and disagree on the arithmetic.** The
paragraph below is why: the 15 are a Windows-only leak, so Windows reaches 45 by
subtraction while Linux reads it off directly. Getting `0` and `45` when
reproducing this on Linux is the law working, not a contradiction — and the two
routes to 45 are independent, which is the strongest thing that can be said
about the figure.

**All 15 on the unmodified tree are the law's own negative-test fixtures** —
strings like `packages/this-directory-does-not-exist/nothing.ts` that exist to
prove the detector bites. They leak in because self-exclusion compares
`packages\server\src\doc-citation-law.test.ts` against forward-slash paths and
never matches; that is the `path-separator` entry this file already carries in
`.windows-known-failures`.

So the real figure is **60 − 15 = 45 dead citations**, and **zero of them are
visible on any platform today**: excluded by directory where the exclusion works,
and buried inside a file written off as known-red where it does not.

Eleven sit in the PRD tree, six of them in PRDs still on the live shelf:

| citing document | dead path |
|---|---|
| `docs/prds/prd-51-the-split.md` | `packages/team/src/auth/` |
| `docs/prds/prd-51-the-split.md` | `packages/team/src/retention/` |
| `docs/prds/prd-51-the-split.md` | `docs/research/2026-08-29-shared-record-s5-pending-invite.md` |
| `docs/prds/prd-51-the-split.md` | `docs/research/2026-08-29-shared-record-s8-vps.md` |
| `docs/prds/prd-54-the-registry-that-checks-itself.md` | `packages/*.ts` |
| `docs/prds/README.md` | `packages/*/src` |

prd-51 is being built against this week. The two research notes it cites were
prd-48 spike outputs that were never written — the PRD already records that fact
in prose, which is why this is a narrowing question rather than a simple fix.

> **Correction to an earlier estimate.** A first pass over this question, using a
> hand-rolled regex rather than the law's extractor, put the figure near 82 across
> ~27 files. That was wrong: it did not strip fenced code blocks and counted
> illustrative globs. The measured figure is 45. Recorded because the method, not
> the number, is the lesson — the law owns an extractor, and a second one written
> beside it will disagree.

## Structure

**F6 — There is no `docs/README.md`. EXECUTED.** 260 tracked markdown files, and
only three of nine `docs/` subdirectories carry an index:

```
adr            INDEX        metamorphosis  none       screenshots  none
design         none         prds           INDEX      user-guide   none
design-notes   none         research       none       review       INDEX
```

There are also **two** research trees — `docs/research/` (37 files) and a
root-level `research/` (6) — and nothing names both, so the second is
undiscoverable from the first.

**F7 — 28 of 55 PRDs carry no Status line in the standard's own form, including
5 of the 12 live ones. EXECUTED.** Counted as `docs/prds/README.md` specifies the
field — a `> **Status:**` blockquote at the head of the document — because that is
the form the standard sets, and the only one a future law could read without
guessing:

```
$ for f in $(git ls-files docs/prds/ | grep -E 'prd-[0-9]+.*\.md$'); do
    grep -qE '^> \*\*Status' "$f" || echo "$f"
  done | wc -l
28
```

The PRD standard says the Status line "exists so a PRD is no longer silent about
its own fate". Nothing tests for it. The live five: `prd-14`, `prd-17`, `prd-20`,
`prd-30`, `prd-34`.

**Those five are not one defect, and the criterion above is why they had to be
stated rather than assumed.** `prd-20` and `prd-34` carry no Status anywhere.
`prd-17` and `prd-30` open with an `> **Outcome:**` blockquote that says what
happened but is not the field. `prd-14` **does** carry one —
`**Status:** BLESSED 2026-08-06`, unquoted and in the body rather than at the
head. It is counted because a Status line a reader has to hunt for is not the
affordance the standard describes; it is named separately because a fix that
treats it like the other four would be writing a second one.

What *is* enforced is the weaker external fact — shelf location against milestone
state, by `prd-location-law`. A PRD can therefore sit on the correct shelf and
still say nothing about itself.

**F8 — One of seven user-guide pages has claim markers. EXECUTED.**

```
docs/user-guide/the-lab.md           56
docs/user-guide/getting-started.md    0
docs/user-guide/replay.md             0
docs/user-guide/sessions.md           0
docs/user-guide/the-desktop.md        0
docs/user-guide/troubleshooting.md    0
docs/user-guide/watching.md           0
```

`the-lab.md` is held to prd53 ruling 9: every behavioural claim is a test, both
directions, 56 of them. The other six pages have no mechanical claim coverage
beyond the generic citation and symbol laws. This is not a defect — it is the
measure of how far the ruling was ever applied — but it is the single largest
unclaimed opportunity in the docs tree, and it is not in scope for this milestone.

## Documents that no longer describe the system

**F9 — `docs/architecture.md` stops at prd-17, and says so. EXECUTED + REASONED.**
2,962 lines. Line 7: *"sections below run prd0 → prd17 and stop there; several
milestones have landed since"*. The live shelf now runs to prd-56 — roughly 39
PRDs later. The banner names the ADR log as the register of record, which is an
honest redirection rather than a silent lie.

Its last touch was 2026-09-11, by `#427`'s mechanical citation update.
**REASONED, and it is the trap in this whole audit: last-modified date is not
evidence of currency.** This document reads fresh by every mechanical signal and
is nearly forty milestones behind in substance. Any future freshness check built
on `git log -1` would pass it.

**F10 — `docs/roadmap.md` still reasons from a private repo. EXECUTED.**
Line 422: *"**macOS CI:** repo is private → claim softened to match verification
(#74)"*. Lines 404–405 carry an open-sourcing prep item — scrubbing guidance for
`user.email` in OTel captures — gated on "before the repo goes public".

The repo is public:

```
$ gh repo view launchpad-26/rhizomorph --json visibility,isPrivate
{"isPrivate":false,"visibility":"PUBLIC"}
```

**And the scrubbing half is already discharged, which the roadmap does not know.**
`packages/server/src/collectors/otel/fixture-hygiene-law.test.ts` mechanically
refuses a live-looking `user.email` in a captured fixture, accepting only
`*@example.com`. Every value in the tree is synthetic — 67 `author@example.com`,
16 `lachlan@example.com`.

**A real-leak check was run and found none.** The only two genuine addresses in
the tree are the deliberate maintainer fields in `packages/app/package.json` and
`packages/app/electron-builder.yml`, which are correct where they are.

**F11 — `docs/vision.md` is the oldest live non-dated document. EXECUTED.**
Untouched since 2026-08-03, and then only by `f5af1fcb`, the
observatory→rhizomorph rename. 40 lines. It opens *"The dreaming doc, solo this
time. Nothing here is a commitment."* **Open, not ruled** — see below.

## What this audit did not check

- **Prose accuracy of the 50 ADRs and 41 archived PRDs.** Both are append-only
  records by standard; they are not expected to describe the present.
- **The six unmarked user-guide pages, claim by claim.** F8 counts the markers; it
  does not verify the prose.
- **`docs/design-notes/` (27 files) and `docs/research/` (37).** Cited-path health
  is covered by F5; the rationale each contains was not re-derived.
- **Screenshots.** Already solved by a law: every tracked PNG carries a manifest
  binding it to the tree it depicts, and a 40-commit staleness bound.
- **Anything under `docs/review/`**, including this file.

## Open questions

- **Is `docs/vision.md` deliberately timeless?** It declares itself a dreaming doc
  and disclaims commitment, which is a legitimate reason for a document never to
  change. It is also the oldest thing in the tree. Rewriting it without the
  operator's word would be inventing a vision. **Open, not ruled.**
- **Should the repo's GitHub wiki be turned off or populated?** `has_wiki` is
  `true`; `git ls-remote` on the wiki remote returns `Repository not found`, so it
  was enabled and never created. An enabled wiki that does not exist is a front
  door onto nothing. **Open, not ruled.**
- **Should live PRDs lose the citation exemption?** F5 is the evidence; the
  narrowing is drafted but not ruled, and it collides with a live prd-51 lane.
  **Open, not ruled.**
