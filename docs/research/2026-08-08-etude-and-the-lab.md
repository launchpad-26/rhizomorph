# Etude and the laboratory — what transfers, graded

**Status:** research note, 2026-08-08 — the SPIKE half of the 2026-07-29 ruling
that gated Etude behind "a real use case". The lab is that use case. Nothing here
is adopted or decided; this is decision support for the leads, one of whom will
discuss it with Etude's author. Grades: **[Read]** = read the code at the cited
line; **[Doc]** = its docs claim it, unverified; **[Inferred]** = my reading, could
be wrong. Etude was cloned read-only to `C:/Users/operator/etude-read` and never
built, installed, or executed. Unprefixed paths are rhizomorph's.

## What Etude is

A Go CLI (MIT, `joshuavial/etude`, 61 commits May–Jul 2026, last 2026-07-30) that
records agent work as **runs** in a git ref namespace —
`refs/etude/runs|evals|retros/*` — then re-executes and judges them. A run is a
manifest of named **stages** (`plan`, `implement`, `verify`, `review`), each with
content-addressed inputs and one output, pinned to a git SHA
(`internal/runmanifest/manifest.go:152-206` **[Read]**). `etude replay <run>
<stage>` re-runs one stage from its recorded inputs; `etude bench <stage>` replays
a cohort of past runs and has an external judge pick a winner between original and
replay. One factual update to the ruling's premise, offered without re-litigating
it: `internal/liverun` (3,639 LOC) is now a stage-executing engine with gates and
worktrees (`liverun/engine.go`, `replay_forward.go:16-22` **[Read]**) — so
"measurement layer, not a runtime" describes Etude as it was, not as it is.

## What the lab has, and what it lacks

The lab checkpoints live (`lab/checkpoint.ts:110-158` — a temp-index `commit-tree`
under `refs/rhizomorph/checkpoints/`), forks n detached worktrees, and compares them
into a table that **refuses to rank**: no sort at any n (`lab/compare.ts:214-218`),
no winner at any n (`:281`), no summary below n=3 (`:257-262`) **[Read]**. Stricter
than prd-12 ruling 4 requires, and the right posture.

Four gaps frame everything below, all **[Read]**. A checkpoint stores *coordinates,
not content* — `sessionFile` + `sessionCutByte` + `sessionDigest` pointing at a
machine-local `~/.claude/projects` file *referenced, never copied*
(`packages/core/src/events/lab.ts:38-43`), so it cannot leave the machine and
`export-record` federates a file that **narrates** an experiment but can never
re-open it. There is **one run per arm** (`lab/fork.ts:219-235`), so `spread()`
(`compare.ts:285-291`) is spread *across arms* — run-to-run variance is confounded
with treatment by construction. There is **no judged outcome and no field for one**:
`LabArmDTO` (`packages/server/src/api/lab.ts:68-79`) has no `outcome`, which is why
prd-14 wave 4's comparison surface is dark in production. And there is **no
redaction anywhere in the record path** — grep for `redact|secret|scrub|sanitiz`
across `packages/core/src/record/` and `cli/export-record.ts` finds nothing.

## Transferable ideas, graded

**1. Label provenance as a typed field that cannot lie. [Read] — the best thing
here.** Etude's benchmark labels carry *where the label came from*:
`GateLabelSource` is `explicit` or `progression-proxy`
(`internal/bench/gate_labels.go:20-25`), a `Verified bool` records whether a human
checked it, and validation **refuses to construct** a proxy label claiming
verification (`:204-206`). Every proxy label is stamped with the repo's own
epistemic warning, held as a constant: *"progression proxy is circular: a gate that
over-blocks can score well against its own historical blocks; prefer verified
explicit labels"* (`:27`). Fills: rhizomorph's missing `outcome` has no provenance
shape, so the first judged outcome the lab records will be indistinguishable from a
verified one. Measured-not-claimed enforced by a type — and philosophically
compatible, because it is about label honesty, not ranking.

**2. Replayability as a declared property of the record. [Read]**
`ArtifactRef.Storage` distinguishes inline content from a pointer
(`runmanifest/manifest.go:199-206`); replay **refuses** a pointer input with
`ErrPointerNotMaterialized` (`internal/replay/resolve.go:142-144`); bench excludes
non-qualifying runs with a *named reason* — `pointer-input`, `stage-ambiguous`,
`replay-run` — listed in the report, not silently dropped (`docs/bench.md:26-42`
**[Doc]**). Its resolver reads the manifest at a resolved commit OID, never the
ref, for a TOCTOU-immune snapshot (`resolve.go:52-62`). Fills: every rhizomorph
checkpoint is effectively a pointer and *nothing says so* — ADR-0010's "declare
what you cannot do" covers collectors but not checkpoints or `export-record`.
**[Inferred]** the cheap honest version is a declared field, not content-addressed
storage; copying transcripts into refs is a far larger decision.

**3. Judge-instability discipline. [Read]** `PairwiseEvaluator` presents targets as
neutral `left`/`right` so the judge cannot infer provenance from role text
(`internal/eval/pairwiseevaluator.go:196-200`), swaps presentation order per pair
from a seed (`:126-160`), and in `DoubleJudge` mode runs **both** orders and
collapses disagreement to a **tie**, confidence set to the conservative minimum and
findings tagged `[A-first]`/`[B-first]` (`:263-317`). The eval cache keys on both
targets' content hashes plus a judge fingerprint plus the seed, and **refuses to
cache a judge whose identity cannot be derived** (`eval/identity.go:23-35`,
`bench/cache.go:76-100`). Fills nothing today — the lab has no judged measure — but
it is the prior art for adding one honestly. **Caveat: `DoubleJudge` is
library-only.** No CLI flag, no doc reference outside its own source comment
**[Read]** — the strongest honesty mechanism here is unwired, exactly as
rhizomorph's comparison artifact is.

**4. A secret scan before a transcript becomes a shareable artifact. [Read]**
`internal/sessionevidence/evidence.go:150-166` fails closed on private-key and
token shapes before capture; the reader keeps `O_NOFOLLOW`, rejects symlink path
components, and admits its parent walk is not race-free (`:27-34`). Fills a live
rhizomorph gap that is a safety defect, not a feature request: `tmux`
`pane.activity` carries `preview` — the raw last non-empty line of a pane capture
(`collectors/tmux/collector.ts:141`, `packages/core/src/events/tmux.ts:34`) — into
the event log, and `export-record` ships those lines verbatim into a hash-chained
`.rhizorecord.json`. Because the chain closes over the lines, a leaked secret
cannot be redacted afterwards without invalidating the record.

**5. An existence proof for #245 option B. [Inferred, from Read evidence]** #245's
option B — "`lab` becomes its own tool that consumes rhizomorph's record" — is
Etude's exact shape, built independently: a separate binary over a `refs/<tool>/*`
namespace, which also fails closed on infrastructure failure rather than booking it
against the subject (`.etude/registry.yaml:12-13`: a seat failure "never counts as a
pass" — `compare.ts:145-149`'s rule arrived at twice). Evidence B is tractable; not
an argument to adopt Etude as the tool.

## What does not transfer, and why

- **The win-rate headline.** `WinRateB = (CountB + 0.5*CountTie)/Total`
  (`internal/bench/aggregate.go:59` **[Read]**) is a scalar verdict — precisely what
  prd-12 ruling 4 and `compare.ts:281` refuse. A real philosophical difference, not a
  gap, and defensible *on Etude's terms*: it ranks A-vs-B on one fixed fixture with
  the task held constant, a narrower claim than ranking arms that differ in
  treatment. Neither side is confused; they answer different questions.
- **Cohort-over-fixtures as the variance answer.** **No repeat runs** — no
  `--repeat`, no stddev, no confidence interval; grep for
  `repeat|variance|stddev|confidence.interval` finds nothing in `internal/`
  **[Read]**. Etude reduces noise by benchmarking N *distinct* past runs, never by
  re-running one — unavailable here anyway, since prd-12 ruling 2 forbids
  synthesizing checkpoints. **So the gem the brief hoped for — a sound answer to
  *agent-run* variance — does not exist in this repo.** What exists is a sound answer
  to *judge* variance (idea 3).
- **The Go stack, the `liverun` engine, the `bd`/beads/Dolt coupling.** A second
  language is a standing tax on a six-week cohort, and importing a second execution
  engine into a process whose *existing* launch hand is under-fenced makes the fence
  problem worse. Etude solves neither #234 nor #245.

## The smallest first step

Neither candidate touches the launch hand, so **#234 gates neither** — worth
saying, because prd-12's amendment means anything that did would have to wait.

- **A — one honesty field.** When the missing `LabArmDTO.outcome` is added (it must
  be, for wave 4 to light), give it a `source` + `verified` shape modelled on
  `GateLabelSource`, so a derived outcome can never read as a measured one. Cost: a
  schema field and a law test. Buys: the lab's first judged measure arrives honest
  instead of retrofitted. Risk: speculative until someone wires `outcome`.
- **B — a secret-scan gate on `export-record`, independent of the lab.** Refuse to
  write a `.rhizorecord.json` whose lines match private-key/token shapes, before the
  chain is computed. Cost: one predicate and its tests. Buys: closes a live gap in
  the one artifact designed to leave the machine. Risk: false positives; needs a
  documented escape.

**[Inferred]** B is the better first step — smaller, a real defect rather than a
design improvement, and it needs no decision about the lab's future. A is worth
filing but belongs to whoever lights wave 4.

## Open questions for JV

1. Is cohort breadth the whole answer to agent non-determinism, or were repeats
   considered and rejected? I found no `--repeat` and no variance statistics.
2. Why is `DoubleJudge` library-only — deliberate (cost per pair), or just unwired?
3. Has `WarningProgressionProxyCircularity` ever stopped you trusting a bench
   number, or is it a comment that never bit?
4. #245's option B is Etude's shape. Would you argue for it here — and what would
   you change about storing artifacts *in* the ref tree versus rhizomorph's
   coordinates-only checkpoint, knowing what you know now?
5. `liverun` looks like a runtime. Does that change what Etude is for?

Not covered: whether rhizomorph should have a judged outcome at all (a ruling, not
a research finding); Etude's `retro`, `import`, SQLite `index`, and `prime`
surfaces, none of which touch a lab gap; and Etude's test quality — I read its
source and docs, not its 60+ KB of tests.
