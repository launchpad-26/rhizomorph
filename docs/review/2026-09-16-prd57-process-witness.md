# prd-57 — the process witness: verification record

> **Tree:** `prd57-w5-the-launch` at `594728ef`, with waves 1–2 on `origin/main`.
> Written 2026-09-16 for prd-57 ruling 10 and Successes 9 and 10.
> Claims are tagged **[Ran]** (a command was executed and its output read) or
> **[Reasoned]** (argued from the tree, nothing executed). Nothing here is
> tagged from documentation alone.

prd-25 ruling 5 asks a verification pass to cite its artifact. This PRD adds
**who ran it and on what**, because there is no workflow leg to cite: Actions
has run nothing on this repository since 2026-09-12 (#438 retired it for cost),
so the artifact and the operator are the whole of the provenance.

## Per platform leg

### Linux — **[Ran]**

| | |
|---|---|
| Who | Lachlan Kelliher, via the conductor session |
| Machine | WSL2 on Windows 11 Home 10.0.26200, Ubuntu 24.04.3 LTS, kernel 6.18.33.2-microsoft-standard-WSL2, x86_64 |
| Node | v22.23.2 |
| Artifact cited | no capture file — and that is the leg's own argument, below |
| Result | green, every wave |

The Linux leg is built and tested against a **fabricated `procRoot`**
(`collectors/process/read-table.test.ts`), and `fixtures/CAPTURE.md` states why
that is sufficient rather than a shortcut: `/proc` is a documented, stable,
plain-text interface and this repo runs on it daily. There is no capture file
for Linux because the interface is not what a capture would be establishing.

What stands behind it instead is the gate. **Linux is this PRD's authoritative
leg**, decided after wave 2, and every wave ran the full suite there with
`origin/main` an ancestor:

| wave | SHA | result |
|---|---|---|
| 3 | `57baed43` | 539 files, 10411 passed, 0 failed |
| 4 | `033eb646` | 540 files, 10416 passed, 0 failed |
| 5 | (this branch) | gated before the PR |

### macOS — **[Ran]**, by someone who is not the author

| | |
|---|---|
| Who | a cohort member, on their own Mac |
| Branch | `prd57-w2-macos-leg` |
| Artifact cited | `fixtures/macos-ps.txt`, `macos-ps-args.txt`, `macos-lsof-cwd.txt` — captured 2026-09-16, recorded in `fixtures/CAPTURE.md` |
| Result | leg landed; reviewed independently by the author |

The review was mutation-verified rather than read: replacing `argvFor`'s parser
with a naive split reddens four tests, including both of the ones that assert a
MATCH through `poll` rather than a successful parse. A Windows-only portability
defect was found on that branch and fixed.

**The OS version and hardware are not recorded here**, because the record from
that leg does not carry them and I will not invent them. That is a gap in this
record, not in the leg.

### Windows — **[Ran]**, partly, and the honest part is which part

| | |
|---|---|
| Who | Lachlan Kelliher |
| Machine | Windows 11 Home 10.0.26200, x86_64 |
| Node | v22.23.1 (portable; the system's 22.9.0 fails `engines`) |
| Artifact cited | `fixtures/windows-cim.json` — captured 2026-09-16, recorded in `fixtures/CAPTURE.md` |
| Result | **witnessed by per-file triage, not by a green run** |

`scripts/ci-local.sh`'s Test leg **cannot go green on native Windows** (#457,
live and unfenced). So no wave of this PRD reports a green local gate on this
platform, and this record does not claim one.

What was done instead, every wave: run the suite, then attribute each failing
test **by NAME** against `.windows-known-failures` and a same-worktree baseline,
never per file. That distinction is load-bearing here — a known-red *file* is
not a known-red *test*, and per-file attribution has already hidden one real
break in this repo.

It hid two more during this PRD, which is the strongest evidence for the rule:

- a comment in `crashed.ts` backticking `diffCrashed`, a symbol that never
  existed, sat inside twelve lines of path-separator noise from
  `doc-citation-law` failing to exclude itself;
- the end-to-end wiring test for #532 is a known drive-letter **timeout** on
  Windows, so when retiring `--extra-sessions` actually broke it, the real
  failure was underneath an unrelated one. Windows could not have shown it.

**The Windows enlist shim is unverified and declared.** A global npm install
puts a `.cmd` on PATH while `argv[1]` is the `.mjs` inside the package, so an
enlist there may write a hook command that does not execute. Nobody has run an
enlist on Windows. Recorded in `api/concierge.ts` beside the code, and in the
PRD's closeout — **[Reasoned]**, never observed.

### Null-only legs

None. All three legs are implemented and none is recorded as null-only for its
platform.

## The soak — **[Ran]**

Two minutes, the real `createProcessCollector` polling **this machine's real
process table** on the production 2s cadence, on the Linux leg.

```
ticks 57 · 120008ms · interval 2000ms · events 0 · errors 0
tick ms: min 33.36 · p50 60.84 · p95 138.71 · max 177.32 · mean 66.67
rss 77.3 MB
```

**What this measures, stated so nobody reads it as more than it is.** `events:
0` is not a fault — no roster-matching agent was running inside WSL during the
window, so every tick walked the whole table and matched nothing. This is
therefore the **floor**: the cost of looking. A soak with live agents would sit
above it, and how far above is not measured here.

Against the 2000ms cadence, p95 is **6.9%** of one interval and the worst tick
is 8.9%. Zero errors across 57 ticks.

Wave 2's single measurement is the point of comparison this sits beside; this
record does not restate it, because a number lifted out of its own conditions is
the thing this section exists not to do.

## Success 10 — the newbie acceptance: **NOT MET**

No person who is not the author has run the instrument from cold.

This is reported not met rather than not assessed, and it is **not simulated**.
The criterion says a described walkthrough is not a performance of it, and that
is exactly what any account I could produce here would be. The macOS leg above
was run by someone else, which is a different criterion (Success 9) and does not
substitute for this one.

What it would take: a person with Claude Code installed and no tmux, one
command in a repo, sixty seconds, and their own words recorded. Until then
Success 10 is open.

## What this record does not cover

- **macOS OS version and hardware** — see that section.
- **A loaded soak** — the measurement above is the idle floor.
- **Windows as a green gate** — impossible while #457 is live; the triage
  method is recorded instead of a result nobody can produce.
