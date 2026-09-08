# prd-54 — the registry that checks itself: an unenforced check is not a check

> **Status:** **BLESSED** — ciaran-slow, 2026-09-08, in session. Milestone `prd54`. Written out of the review of
> [#353][i353], which registered one coupling point and found in passing that the registry it
> writes into is unverified prose, and that the script written to verify it is wired to nothing.
> Two waves, and the first is a correction rather than a feature.

## Problem

`.swarm/coupling.txt` is the repo's pre-dispatch warning system: 20 entries on `main` today of
**prose asserting facts about other files** — that a law pins an exact count, that a spelling is a hit, that a path
is quoted verbatim elsewhere. A lane reads it to learn what its fence cannot see coming, and
`scripts/fence-lint.sh` refuses to run without it.

Nothing checks whether any of that is still true. The file's header names the standard it is held
to — *"an entry with no reason is worse than no entry … a warning nobody can judge is a warning
everybody learns to skip"* — and a **stale** reason is the worse case that sentence does not
reach: it is judgeable, and wrong. The bill is paid by the next lane, which trusts a sentence,
writes the spelling it was told was safe, and goes red in a directory it never entered.

## Evidence

Measured 2026-09-08 over every entry, and re-derived against `main` after a rebase rather than
against the lane it was drafted on — the count is **20 on `main`**, becoming 21 when [#353][i353]
lands. An earlier draft of this section said 21 and attributed it to `main` at `0c6b4285`, which
was the figure from the lane that adds the twenty-first entry. Re-derive it; do not trust it.

- **The check exists and runs nowhere.** `grep -rn "coupling.test.sh" .github/workflows/ scripts/
  package.json` returns only the script's own header lines. `scripts/dev/coupling.test.sh` is in
  no workflow, no `package.json` script, and not in `scripts/gate.sh`. It passes only when
  somebody remembers it; nobody did, which is why the next bullet is true.
- **Every entry that quotes a numeric assertion literal is wrong — both of them.** The
  `theme/tokens.test.ts` entry (the file's *first*, its exemplar) says "an exact `.toBe(225)`";
  the file pins `.toBe(RAW_PIXEL_SIZES)` with `const RAW_PIXEL_SIZES = 0` (`tokens.test.ts:243`)
  under a comment reading "The ratchet is now a wall", which makes the entry's own
  both-directions argument vacuous at zero. The `api/route-class-law.test.ts` entry quotes
  `.toBe(25)` twice; the file pins `30` twice (`route-class-law.test.ts:118-119`). A third entry
  quoted `.toBe(14)` when [#353][i353] was first written, and was corrected to cite its constant
  by symbol before landing — under Ruling 2 below, which is why the class now has two members
  rather than three. Re-derive this count rather than trusting it; it moves as entries are
  written.
- **A cited path already fails to resolve, legitimately.** `.swarm/timing-count`, cited by the
  `scripts/gate.sh` entry, is absent: `.gitignore:17-18` excludes `.swarm/*` bar `coupling.txt`,
  and `gate.sh:570` creates it on first use. A naive "every cited path exists" check
  false-positives here — the case that makes this need a ruling, not a one-line grep.
- **False claims in this file survive the entire gate indefinitely, and no law can reach them.**
  One entry, [#353][i353]'s, took **five** rounds of independent review to become true. In order:
  the inverse of a detector shape; then a window overstated by a line plus a denial of a
  `path.relative` call the file has; then "a string-literal argument is safe" full stop, whose
  cited probe had been run in a context that could not falsify it; then a quoted `.toBe(14)` that
  occurs nowhere in the cited file; then five more, three of which had survived every previous
  round — including a `(prd-54 ruling 2)` citation pointing at a document absent from that tree.
  Every one of those versions passed `typecheck`, `lint`, the 430-file suite and
  `coupling.test.sh` 11/11. The round-5 audits also disagreed with each other: 28 claims
  enumerated and no defects found, against 54 claims and five defects, all five confirmed. A
  clean verdict from one reader is not evidence. `doc-citation-law.test.ts`'s citing-file
  predicates are `packages/*.ts`, `docs/*.md` and `*.md` (`:980`, `:2091`) — this is a `.txt`.
- **The rule is already written in the file, unenforced.** Its `gate.sh` section instructs every
  entry to cite anchor text and never a line number, because *"a registry entry pinned to a
  number for a file that moves is a registry entry that rots by construction."* The two stale
  entries are that sentence coming true one step over — pinned to a **value**, not a line.
- **What `coupling.test.sh` checks is presence, not truth** (`:52-67`): the file exists, is
  tracked, N entries parse, each leading path exists, each reason does not merely repeat its own
  path. Nothing opens the cited file.

## Success

1. **The registry's checks run without anyone remembering them.** Not met while
   `coupling.test.sh`'s assertions can pass only when invoked by hand.
2. **A stale quoted value fails a gate.** Not met while changing a pinned count in a cited file
   leaves the registry green.
3. **An unresolvable cited path fails a gate, and the generated-file case does not
   false-positive.** Not met while `.swarm/timing-count` either reddens the check or must be
   deleted from the entry that legitimately cites it.
4. **Every entry is true the day the law lands.** Not met while the tokens entry reads 225 and
   the route-class entry reads 25.

## Non-goals

- **Not a rewrite of the registry's prose.** The entries are long on purpose; length is not the
  defect. Only claims a machine can check are in scope.
- **Not a general prose-truth checker.** "This fails in both directions" is a judgement and stays
  one. Two claim classes are mechanical — a backticked repo path and a quoted assertion literal —
  and those are the whole surface.
- **Not `fence-lint.sh`'s unreachable WARN branch**, which `coupling.test.sh:93-110` already
  asserts and records as deliberate, nor the two coupling entries still owed ([#358][i358]).

**Rejected alternatives.** *Fold the checks into `doc-citation-law.test.ts`* — already the repo's
largest law, and its scope is itself a ruling (`:81`); widening it to a `.txt` outside `docs/`
re-opens that ruling to buy nothing needed here. *Keep it shell and add `coupling.test.sh` to
`scripts/gate.sh`* — the gate is the operator's step on the operator's machine, so CI would still
never see it and Success 1 would be met in name while a pushed branch stayed unchecked. *Ban
numeric literals from the registry* — the numbers are the most useful thing in an entry; the
defect is that they are unchecked, not that they exist.

## What already exists (do not rebuild)

- `scripts/dev/coupling.test.sh` — the parser and the presence checks. Extend or port; do not
  rewrite its semantics.
- `scripts/fence-lint.sh:79-81` — the canonical entry parser (`${line%%#*}` + `xargs`). A new
  reader must agree with it exactly, or the law checks a different file than the lint reads.
- `packages/server/src/gate-honesty-law.test.ts` — the anchor-text pattern, and the
  collection-time-throw failure mode not to repeat.
- `packages/server/src/doc-citation-law.test.ts` — `trackedFiles()`, and its precedent for an
  explicit asserted opt-out over a silent exclusion (`:81`, #649's lesson).

## Rulings

## Ruling 1 — the registry's law is a vitest law; the shell script stays the operator's fast path

Checks that must not rot land as a test the suite runs, because the suite is what CI and the
landing gate both execute. `coupling.test.sh` is kept and stays runnable by hand, but stops being
the only thing that knows these rules. Extent: the law owns the two mechanical claim classes in
Rulings 2 and 3. It does not absorb the script's `fence-lint.sh` behavioural cases, which test a
shell script and belong in shell.

## Ruling 2 — an entry cites a symbol; a value it also states must be verifiable in the cited file

A reason may quote an assertion literal, but the quoted form must occur **verbatim in the cited
file**. Where the pinned number lives in a named constant, the entry cites the **constant** and
may give its value as an as-of statement, which the law resolves from the constant's initialiser.
`.toBe(225)` against `.toBe(RAW_PIXEL_SIZES)` is exactly what this forbids: a quoted form that
has never appeared in that file. Extent: every backticked `.toBe(N)` / `.toHaveLength(N)` in any
reason. Not prose numbers outside backticks — Open question 1.

*Amendment note, 2026-09-08, same session as blessing.* [#353][i353]'s entry was audited against
this ruling before landing and tripped it on a case the ruling does not anticipate: the entry
quoted `` `.toBe(14)` `` **in order to say that form appears nowhere in the cited file**. A
verbatim-occurrence check cannot tell that apart from a stale quote — it is the `.swarm/timing-count`
problem of Ruling 3 in the other direction, a claim that is true *because* the thing is absent. The
entry was reworded to avoid quoting the absent form at all, which is the cheap fix and probably the
right house style; whether the law needs an explicit "asserted absent" declaration, or whether
forbidding the construction is enough, is **open, not ruled**. Recorded here rather than as a new
ruling because Ruling 2's verdict is unchanged — only its edge is now known.

*Amendment note 2, 2026-09-09, from the independent review of this document at `fa64a7a7`.* A
second edge, of the same class as the one above and found the same way — by auditing an entry
against the ruling rather than by writing code to it. **This ruling's two sentences disagree about
what unit is checked.** The body requires the quoted *form* to occur verbatim; Extent names
`` `.toBe(N)` / `.toHaveLength(N)` ``. Read as a selector — which spans are in scope, with the
body's check then applied to the whole backticked span — the two agree. Read as the thing to check,
Extent lifts the assertion token out and asserts only that, and the ruling goes green on a stale
entry whenever the retired number still occurs anywhere in the cited file for an unrelated reason.
The exemplar cannot distinguish them, because the tokens entry's span *is* `` `.toBe(225)` ``.

The route-class entry can, and `api/route-class-law.test.ts` carries the decoy that makes it bite:
`expect(gatedFound.length).toBe(25)` counts gated routes, while the two pins that entry actually
claims stand at `30`. EXECUTED over all 21 entries at `fa64a7a7` — three spans are in scope in the
whole registry, and the two readings disagree on two of them:

| entry's cited file, and the span | whole span | token only |
|---|---|---|
| `theme/tokens.test.ts` — `` `.toBe(225)` `` | absent | absent |
| `api/route-class-law.test.ts` — `` `expect(ROUTE_CLASSES.length).toBe(25)` `` | absent | **present** |
| `api/route-class-law.test.ts` — `` `expect(routes.length).toBe(25)` `` | absent | **present** |

So the token reading passes two of the three false claims this PRD was written to catch, including
Success 4's own route-class example; the span reading reddens all three and nothing else, with no
false positive on the other 18 entries — a law that lands with no allowlist, which is what Ruling 4
exists to secure. **Open, not ruled**, and left to the same wave-0 act as the edge above, which
[#367][i367] is already blocked on: the measurement says which reading works, but naming the unit
is a change to this ruling's words and belongs to whoever settles it. Recorded here rather than as
a new ruling because Ruling 2's verdict is unchanged — the body already says "form"; only the
disagreement between its two sentences is now known.

One thing the measurement does not reach, for whoever writes the law: it took each entry's **leading
path** to be "the cited file". A reason quoting a form that belongs to some other file it names
would be judged against the wrong file. No entry does that today — all three spans above belong to
their own entry's file — so it is not a live defect, but the law will need a position on it.

## Ruling 3 — a cited path must resolve, or be declared generated in the entry itself

Every backticked repo-relative path in a reason must exist, with one declared exception: a path
git deliberately ignores and a tool creates. Such a path is marked generated in the entry, and
the law then asserts its **generator** references it — for `.swarm/timing-count`, that
`scripts/gate.sh` names it. Extent: the declaration is per-path and asserted, never a filename
pattern. That is #649's lesson, which the doc-citation law already carries — scope a guard by what
a file *is*, not by what it is called — and the reason this is a ruling and not a detail.

*Amendment note, 2026-09-08, same session as blessing.* An exhaustive audit of [#353][i353]'s
entry surfaced that "repo-relative" is the wrong bound: the registry's own convention inside a
reason is **package-relative shorthand** — `paths/containment.ts`, `theme/tokens.test.ts`,
`app/StatusBar.tsx`, `drawer/Conversation.tsx` — none of which resolve from the repo root. A law
written to this ruling's literal wording would redden nearly every entry in the file on its first
run, including the three entries the ruling was written to protect. The verdict stands; its
resolution rule does not exist yet. Whether the law resolves a reason's paths against the entry's
own leading path — which would make the shorthand correct by construction — or the shorthand is
expanded file-wide instead, is **open, not ruled**, and must be settled before wave 2 writes the
check rather than during it.

## Ruling 4 — the rot is corrected before the law exists, in its own wave

The tokens and route-class entries are corrected first, as a wave of their own. A law landing
beside its own two red entries either arrives red or arrives with them allowlisted, and an
allowlist minted on day one is how a ratchet becomes decoration. Extent: wave 1 corrects claims
and nothing else — no new entries, no rewording beyond what truth requires.

## Sequencing (waves, each gated as ever)

`.swarm/coupling.txt` is also [#353][i353]'s and [#358][i358]'s fence; both are **charter-laws**
issues and land before wave 1 starts, or wave 1 rebases onto them. No wave enters
`scripts/fence-lint.sh` (Non-goals), and none enters `doc-citation-law.test.ts`, which is prd-17
territory.

**Wave 1 — the Keystone: the registry's own claims are true.** Claimed by nobody downstream but
the law that checks it. Corrects the `tokens.test.ts` entry (`.toBe(225)` → the `RAW_PIXEL_SIZES`
symbol, today 0, with the both-directions framing re-stated honestly at zero) and the
`route-class-law.test.ts` entry (`.toBe(25)` → 30, twice). One file: `.swarm/coupling.txt`.

**Wave 2 — parallel, fenced apart:** the law itself, asserting Ruling 2's verbatim-or-symbol check
and Ruling 3's resolve-or-declared-generated check over every entry, in a new test file under
`packages/server/src/` · the generated-path declaration for `.swarm/timing-count` in
`.swarm/coupling.txt`, with `scripts/gate.sh` asserted as its generator ·
`scripts/dev/coupling.test.sh` keeping its presence checks and gaining a pointer to the law, so
the two cannot silently diverge.

**Unfiled work implied, described not numbered:** whether an entry's reason should be generated
from the law it describes rather than written beside it; and a sweep of the other 18 entries'
un-backticked prose claims, which no ruling here makes checkable.

## Open questions

1. **Does a number outside backticks need checking too?** [#353][i353]'s entry says "14 today
   across seven files", none of it backticked, and Ruling 2 does not reach it. Requiring
   backticks around every checkable number would — at a cost in readability. **Open, not ruled.**
2. **Should the law fail, or warn, when a cited file no longer trips its own detector?** That is
   the strongest check available — `prefix-comparison-law.test.ts` already does it for its own
   allowlist — and may be too expensive to generalise. **Open, not ruled.**

[i353]: https://github.com/launchpad-26/rhizomorph/issues/353
[i358]: https://github.com/launchpad-26/rhizomorph/issues/358
[i367]: https://github.com/launchpad-26/rhizomorph/issues/367
