# prd-25 — the third platform: anywhere, with a gate that looks

> **Status:** blessed by the operator, 2026-08-24 — rulings 1–6 accepted, the three human
> calls answered in the amendment. **Groomed 2026-09-02** into #210, #211 and #212, which are
> the whole of what remains; see the closing amendment for the three rulings the tree
> discharged on its own. Revalidated at `26c48c7`: still no `windows-latest` leg on either
> `ci.yml` job (the desktop installer workflow's Windows row packages the shell; it runs no
> suite).

## Problem

A cohort member on native Windows cannot get past the front door, and the repo cannot
honestly say so. `npm run build` then `npm start` — the five-minute guide, verbatim — dies
before a collector runs, while an *unbuilt* clone boots: building the project is what
closes the door. Nothing looks — CI is ubuntu + macOS, both legs pass either way, and the
support matrix (`README.md:264–270`) has no Windows row at all. The cost is a new
contributor's first hour, and the README, this project's trust document, being wrong in
the first place a stranger reads.

## Evidence

- **#281 — a built clone cannot boot on Windows.** `packages/server/bin/rhizomorph.mjs:14`
  dynamic-imports `path.resolve(...)` raw, and win32 parses the drive letter as a URL
  scheme (`ERR_UNSUPPORTED_ESM_URL_SCHEME`, protocol `'c:'`); line 15's tsx fallback is a
  relative specifier, hence unbuilt boots and built does not. Its own honesty note: no
  existing CI leg can witness the fix.
- **#277 — the first native Windows run of the suite, ever** (Windows 11, node 22.23.1,
  main `e5a4c8d`): **130 failed / 3,279 passed / 3 skipped of 3,412** across **15 files** —
  14 server (`lab/`, `collectors/sessionlog/`, `recorder/`, `api/`, `cli/`), 1 core (the
  eras golden byte-identity, a CRLF suspect); typecheck green. Two blockers before any test
  ran: `engines` demands node `>=22.22.2` (stock 22.9 EBADENGINEs), and
  `@rolldown/binding-win32-x64-msvc` was absent after `npm ci`, crashing vitest
  MODULE_NOT_FOUND until installed `--no-save`.
- **The CRLF suspect, verified in the tree.** No `.gitattributes` exists anywhere, and
  under `core.autocrlf=true` (the Git-for-Windows default)
  `packages/core/src/eras/era-1/recording.jsonl` holds 100 CR to 100 LF. That same README
  section calls macOS "Unverified … treat it as untested" though ci.yml runs `macos-latest`
  on every push, and says "Node >= 22".
- **`docs/research/2026-08-07-docker-and-distribution.md`** (PR #275): Docker is no for the
  runtime — every core signal is a host fact, a container is L0-at-best, and containers on
  Windows run Linux, leaving this gap where it is. Its rulings A and B are **proposed,
  awaiting the leads**.

## Success

A built clone boots natively on Windows and a gate re-checks it every push; the Windows
suite result is a **name, not a discovery** — a committed list of known-failing files, where
a failure outside it turns a leg red; the README's front-door commands work as written on
all three platforms, each matrix row naming the artifact that proves it; and a stock Windows
machine reaches a running instrument with no undocumented step. **Not met while** the boot's
only proof is a hand-run transcript, the 130 is a number in an issue comment, the matrix has
no Windows row, or the setup blockers are discoveries rather than documented.

## Non-goals

- **Not Docker** — the brief's proposed ruling A, awaiting the leads; nothing here depends
  on the answer.
- **Not the adapter contract or cross-CLI cost parity** — prd-15 rulings 3 and 4 own those.
  No new adapter, collector, event type or UI surface.
- **WSL is not the answer.** It works today, is in the matrix, and stays — but it is a Linux
  userland, and every failure captured tonight (drive letters, separators, no `/proc`, a
  CRLF checkout) is invisible from it. The promise was "anywhere", not "via a Linux VM".
- **Not fixing the 130 blind** — triage precedes fixes (ruling 3). **Not publish work** —
  that machinery is built and dormant by prd-15's ruling.

## Rulings

*Every ruling is a **proposed** verdict with its reasoning; nothing here is decided, and
where a human must rule, the ruling says so.*

## Ruling 1 — the matrix gains a `windows-latest` leg, arriving on `pack-smoke` first

#281 is right that neither existing leg witnesses its fix and wrong that none could:
`pack-smoke` installs the tarball and runs the CLI from the installed files after a build —
exactly the built-clone path that dies on win32. The oracle is a third OS, not a new test.
It must start on `pack-smoke`, never `build-test-boot`, because a failed `Test` step **skips
every later step on that leg** (AGENTS.md): with 130 failures that leg goes red at Test and
the boot smoke never runs. Honest cost — `windows-latest` bills 2× ubuntu against the macOS
leg's 10× (ci.yml's own comment), and `scripts/pack-smoke.sh`'s POSIX process control (`&`,
`trap`, `kill -TERM`) is the part to prove, not the pack. **A human rules the CI spend.**

## Ruling 2 — the Windows pin is a file list, not a number, and may only shrink

The gate enforces "no *new* Windows failures" against a committed list of #277's 15 files,
never the scalar 130 — a count masks a swap, one fixed and one newly broken. A list is
falsifiable per file: outside it is red, removing an entry is a normal PR, adding one is
not. Zero is the destination, not the entry price.

## Ruling 3 — the 130 are classified before any one is touched

A cause class per file — path separator, drive-lettered absolute path, `/proc` absence, line
endings, process signalling, temp-dir shape — each class becoming one fenced issue. Fifteen
files with six causes is not fifteen lanes of guesswork, and the classification is what
shows the legs are not redundant: macOS carries path-shape signal because `os.tmpdir()` is a
symlink there (AGENTS.md), Windows a different one.

## Ruling 4 — a contributor's setup is the repo's problem: line endings become law, the floor holds, the README changes

**Line endings:** a `.gitattributes` pinning `eol=lf`, at minimum for the era corpus and the
JSONL/JSON fixtures — that corpus arrives through `?raw` and cannot be re-blessed from inside
the suite, so a CRLF checkout makes the *input* lie with no in-suite repair. **The floor**
stays `>=22.22.2` (CI pins it exactly on the min-node leg, deliberately) and the README's
"Node >= 22" changes, so a first EBADENGINE is a stated requirement, not a contradiction.
**The lockfile binding** gets a diagnosis, not a blind fix: the entry is present and
correctly constrained (`os:["win32"]`, `cpu:["x64"]`, `optional:true`), so the cause is
unknown and ruling 1's leg answers it. **Whether 22.22.2 is the right floor is a human's
call.**

## Ruling 5 — support-matrix rows move only on a named artifact

Extending prd-15 ruling 7's "rows move only on evidence": each row cites the workflow leg or
dated note behind it, and Windows enters as an honest partial — boots, N known failures, see
the note — never as a blank. The macOS row is corrected in the same pass; "treat it as
untested" beside a leg that runs on every push is wrong in the costliest direction.

## Ruling 6 — publish sequences behind this, and this PRD does not touch it

prd-15 wave 8 already puts publish last, after wave 6, and the docker brief's **proposed**
ruling B keeps 6 → 8 with no new installer work. This PRD supplies wave 6's content and adds
one precondition — a Windows matrix row backed by a leg. The remaining publish gate (#177)
exists, stays the leads', and its content is not this document's business.

## Sequencing (waves)

Continuing prd-15's numbering — its wave 6 is the Windows leg; waves 3–5, 7 (PTY/L3) and 8
(publish) are untouched. New issues are described, never numbered.

- **6a, prerequisite, in flight:** **#276** — it owns the `README.md` fence #277 needs, and
  its clone-safe commands are what the pass types.
- **6b, keystone:** **#281**'s one-line `pathToFileURL` fix, landed with the
  `windows-latest` `pack-smoke` leg that witnesses it *(new issue: that leg, including the
  process-control question in `scripts/pack-smoke.sh`)*.
- **6c:** **#277** completes — captures for its four areas plus ruling 3's triage *(new
  issues: one per cause class, only after the triage)*.
- **6d, parallel, fenced apart:** the `.gitattributes` and corpus re-verification · the
  node-floor and binding work · the matrix rows *(new issues: three)*.
- **6e:** the cause-class fixes, then the leg moves onto `build-test-boot` behind ruling 2's
  list *(new issue: the promotion)*.

## Open questions

- Whether `windows-latest` belongs on `build-test-boot` at all, or whether pack-smoke plus a
  dated manual pass is the honest ceiling for a repo this size — a leads' call on CI spend.
  Open, not ruled.
- Whether the pin is a skip list (green, silent) or an expected-fail list (visible, noisy).
- Whether ConPTY needs an answer before prd-15 wave 7 — its ruling 7 names it, nothing has
  probed it. Open.
- The docker brief's rulings A and B stay proposed; if either is answered differently, ruling
  6 changes and nothing else here does.

## Amendment — blessed, with the three human calls answered (operator, 2026-08-24)

Ruled on the retained-PRDs review's recommendation, against the tree at `9a26030`. Rulings
1–6 stand as written, with these answers and corrections:

- **The CI spend (ruling 1's call):** the leg starts on `pack-smoke`, on every push. Whether
  `windows-latest` ever joins `build-test-boot` is decided later, against the leg's measured
  cost and the triage's shape — the first open question above closes to "pack-smoke now;
  promotion is its own decision, made with numbers".
- **The pin's shape (the second open question):** an **expected-fail list** — visible, noisy,
  an honest partial. A skip list renders debt as health, the reading this repo legislates
  against; ruling 2's list therefore reports its entries on every run rather than silencing
  them.
- **The node floor (ruling 4's call):** stays `>=22.22.2`. The README wording change ships
  with ruling 4 as written.
- **The keystone is smaller than wave 6b says.** #281's `pathToFileURL` fix already landed
  (`packages/server/bin/rhizomorph.mjs:51–53`); the Evidence bullet stating the defect in the
  present tense is history. What remains of 6b is the leg alone — which now also carries the
  burden of witnessing the landed fix for the first time.
- **Success is staged.** The committed known-failure list binds at promotion time (6e), not at
  the first smoke; the smoke's own bar is "a built clone boots natively and a leg proves it on
  every push".
- **The numbering de-anchors from prd-15**, retired as superseded this same day: the waves
  above renumber as this PRD's own at grooming, and prd-15's wave 7 (PTY/L3) is now prd-20
  ruling 7's parked option — the ConPTY open question above points there, not at prd-15. The
  docker brief's rulings A and B stay proposed and untouched.

## Amendment — what the tree discharged before grooming (2026-09-02, #222)

Groomed against `main` at `26c48c7`. Rulings are never renumbered and none is deleted; three
are marked discharged with the evidence that discharged them, and one keeps its conclusion
while losing its premise.

**Ruling 4's node-floor call — DISCHARGED.** It asks that the README's "Node >= 22" change so
a first `EBADENGINE` reads as a stated requirement rather than a contradiction. `README.md`
already reads **"Node >= 22.22.2"**, names `engines` in `package.json` as the source of truth,
records that CI pins that exact minimum, and points at CONTRIBUTING.md for the Node 20
behaviour. Nothing is owed. The floor itself stays `>=22.22.2`, as the 2026-08-24 amendment
ruled.

**Ruling 5's support-matrix rows — DISCHARGED.** It asks that Windows enter as an honest
partial and that macOS's "treat it as untested" be corrected in the same pass. The matrix
already carries four rows: macOS reads "CI-verified on every push" with its legs named, and
Windows reads as an honest partial that cites the fixed boot defect and this PRD. Both
corrections landed.

**The Evidence bullet on the boot defect is history.** `packages/server/bin/rhizomorph.mjs`
uses `pathToFileURL(distEntry).href`; win32 no longer parses the drive letter as a URL scheme.
The bullet is preserved above as the record of why the leg is owed — no CI leg has still ever
witnessed the fix — but it no longer describes the present tense.

**Ruling 1 keeps its conclusion and loses its premise.** It argues the leg must start on
`pack-smoke` because "a failed `Test` step **skips every later step on that leg**", so the
boot smoke would never run. That has not been true since `ci.yml`'s post-`Test` steps were
gated on `!cancelled()`; `AGENTS.md` carried the same stale claim and #215 corrects both. The
conclusion survives on a different argument, recorded on #211: a `build-test-boot` Windows
leg would be **permanently red** while the suite's known native failures have no committed
expected-fail list, and a leg that is always red teaches everyone to ignore it. Giving the
suite that list is ruling 2's job and #212's. The premise is corrected here rather than
quietly repaired, because the repo learning that its own gate changed is the durable part.

**What remains of this PRD:** #210 (the `.gitattributes` line-endings law, ruling 4's other
half), #211 (the `windows-latest` pack-smoke leg, ruling 1) and #212 (the committed
expected-fail list and the triage, rulings 2 and 3). Ruling 3's per-cause-class fixes are
deliberately unminted until the triage runs. Ruling 6 is untouched.

## Amendment — ruling 3 gains a seventh cause class (operator, 2026-09-03, #212)

The first native `windows-latest` run of the suite (#212's measurement, run 33706746540:
29 failing files of 405) classified 28 files into ruling 3's six classes and left one that
fits none: `packages/server/src/server/static.test.ts`, whose two Windows failures come
from file-open semantics — win32 ignores `O_NOFOLLOW`, so the final-component symlink is
followed, and a wildcard tail under a real file raises no `ENOTDIR`. Neither is a path
shape, a line ending, a process, `/proc`, or the temp dir. Ruling 3's classes are a claim
about Windows failure causes, and the claim was one class short.

**Ruled:** a seventh class, **`fs-semantics`** — open flags (`O_NOFOLLOW`), symlink
following, `ENOTDIR` on a file-as-directory, and the other POSIX file-API semantics win32
does not honour. It is added to `.windows-known-failures`' header and to
`scripts/windows-triage.sh`'s accepted set; `windows-suite-law.test.ts` holds all three
equal. Widening an existing class (`temp-dir`'s "case-insensitive FS") was considered and
rejected: a class that means two things is not a lane. Gating the two cases with
`skipIf(win32)` was rejected for the reason the 2026-08-24 amendment already gives — a skip
list renders debt as health.
