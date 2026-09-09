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
has never appeared in that file. Extent: an assertion call inside a backticked span **selects**
that span as in scope — see Ruling 7, which settles that this sentence selects and the body above
checks, and which widens the selector to a symbolic argument as well as a numeric one. What must
occur verbatim is the whole span, not the assertion token lifted out of it. Not prose numbers
outside backticks — Open question 1.

*Amendment note, 2026-09-08, same session as blessing.* [#353][i353]'s entry was audited against
this ruling before landing and tripped it on a case the ruling does not anticipate: the entry
quoted `` `.toBe(14)` `` **in order to say that form appears nowhere in the cited file**. A
verbatim-occurrence check cannot tell that apart from a stale quote — it is the `.swarm/timing-count`
problem of Ruling 3 in the other direction, a claim that is true *because* the thing is absent. The
entry was reworded to avoid quoting the absent form at all, which is the cheap fix and probably the
right house style; whether the law needs an explicit "asserted absent" declaration, or whether
forbidding the construction is enough, was open. Recorded here rather than as a new ruling
because Ruling 2's verdict is unchanged — only its edge was then unknown.

— **ANSWERED (operator, 2026-09-09): forbidding the construction is enough.** See **Ruling 6**
below, which refuses a quoted form that does not appear in the cited file even when the point is
its absence. This answers THIS note only. Amendment note 2 below, added the same day by the
independent review of `fa64a7a7`, raises a second and separate edge of this ruling — which *unit*
is checked — and that one is still **open, not ruled**. Ruling 6 does not settle it, and #367
still blocks on it.

*Amendment note 2, 2026-09-09, from the independent review of this document at `fa64a7a7`.* A
second edge, of the same class as the one above and found the same way — by auditing an entry
against the ruling rather than by writing code to it. **This ruling's two sentences disagree about
what unit is checked.** The body requires the quoted *form* to occur verbatim; Extent names
`` `.toBe(N)` / `.toHaveLength(N)` ``. Read as a selector — which spans are in scope, with the
body's check then applied to the whole backticked span — the two agree. Read as the thing to check,
Extent lifts the assertion token out and asserts only that, and the ruling goes green on a stale
entry whenever the retired number still occurs anywhere in the cited file for an unrelated reason.
The exemplar cannot distinguish them, because the tokens entry's span *is* `` `.toBe(225)` ``.

— **ANSWERED (operator, 2026-09-09): the unit is the whole backticked span.** See **Ruling 7**
below, which settles that this ruling's Extent sentence *selects* and its body *checks*, and
widens the selector to symbolic arguments. This note asked for both of Ruling 2's edges to be
settled by one wave-0 act; they were settled by two, because the absence question was decided
before this note existed — Ruling 6 for the absence edge, Ruling 7 for this one. The measurement
recorded above was re-derived independently before Ruling 7 was written, and held: the span
reading reddens all three false claims, the token reading one of the three. Both of this ruling's
edges are now closed.

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
expanded file-wide instead, was open, and had to be settled before wave 2 wrote the check rather
than during it.

— **ANSWERED (operator, 2026-09-09): both, in a fixed order, and nothing else.** See **Ruling 5**
below. Measured before deciding: the whole registry carries ten backticked path citations, so the
strict rule costs three path expansions in one entry rather than the file-wide sweep this note
feared. (The measurement said nine when this note was first answered; the tenth was found in the
review of the PR that landed Ruling 5, and Ruling 5 records what the miscount cost.) This ruling's
edge is now closed.

## Ruling 4 — the rot is corrected before the law exists, in its own wave

The tokens and route-class entries are corrected first, as a wave of their own. A law landing
beside its own two red entries either arrives red or arrives with them allowlisted, and an
allowlist minted on day one is how a ratchet becomes decoration. Extent: wave 1 corrects claims
and nothing else — no new entries, no rewording beyond what truth requires.

## Ruling 5 — a reason's path resolves repo-relative, or against the entry's own package root, and nowhere else (settles ruling 3's open edge)

**Verdict.** A backticked path in a reason is checked by exactly two attempts, in
order: as **repo-relative**, and — only if the entry's own leading path lies
inside a package source root — as relative to **that one root**. Nothing else is
tried. A citation that resolves under neither must be written repo-relative, and
a citation that resolves nowhere at all fails, unless it is declared generated
under ruling 3.

**Why, measured over all 21 entries on `main` (2026-09-09).** There are **ten**
backticked path citations in the whole registry, and every one of them gets a
defined verdict under this rule:

| how it resolves | count | verdict |
|---|---|---|
| repo-relative | 2 | passes |
| under the entry's own package source root | 4 | passes — this is the shorthand ruling 3's note found |
| only under **another** package's root | 2 | **must be expanded** — both are `api/index.ts` and `cli/index.ts` in the `README.md` entry |
| under neither attempt, but the file exists | 1 | **must be expanded** — `manifest-law.test.ts` in the `README.md` entry, which is `packages/app/src/host/manifest-law.test.ts` |
| nowhere at all | 1 | `.swarm/timing-count`, handled by ruling 3's generated declaration |

So the total cost of this rule is **three path expansions**, all three in one
entry, and all three already in wave 1's file. That is what makes it affordable
to be strict: the alternative rules below are only cheaper in theory.

**This paragraph said nine.** The first draft of this ruling counted the
population by eye and reached nine, missing `manifest-law.test.ts` — a bare
filename with no `/` in it, which is exactly the
shape the eye reads as prose rather than as a citation. It was found by an
independent re-derivation of all fourteen path-shaped spans in the review of
this PR, not by the audit that produced the nine. That is the second time in
this PRD a hand-count of the registry has come back wrong (the first is the
Evidence section's 21), and it is the argument for the Extent sentence below:
the population a rule applies to is itself a thing the law must decide, or the
next reader re-does the judgement and gets a different number.

**Why not "try every package root".** It would pass nine of the ten with no
edits — `manifest-law.test.ts` sits at `host/` inside its package and resolves
under no root at all — and it is the wrong trade. `theme/tokens.test.ts` would
be satisfied by the first package that happens to contain that relative path,
so a citation could resolve
against a **different file than the one the author meant** and still pass — a
check that is true and useless, which is #649's lesson and the reason ruling 3
exists at all. Determinism is the point: two attempts, both nameable in the
failure message, no search.

**Why not "require repo-relative everywhere".** It would also work, at the cost
of expanding four legible shorthand citations into long paths inline, in a file
whose entries are already long. The shorthand is genuinely readable *inside its
own package* — `app/StatusBar.tsx` in a `packages/web/src/theme/…` entry is
unambiguous to a reader and to this rule. It is only ambiguous across packages,
which is exactly where this ruling forbids it.

**Extent, and first what this is the extent *of*.** A backticked span is a path
citation when it carries **no glob metacharacter** and **either contains a `/`
or is a bare filename not beginning with a `.`**. The law decides that, not the
reader — this is ruling 7's shape applied to paths, where the ruling names the
selector rather than leaving wave 2 to reconstruct it. The rule admits the ten
counted above and excludes the four backticked spans in the registry that cite
nothing: `` `.test.ts` `` and `` `.test.tsx` `` (twice) are suffixes, and
`` `*.bench.test.ts` `` is a glob. Success 3's second clause — *"and the
generated-file case does not false-positive"* — is the criterion those four
would fail against, so leaving the selector to the law's author is leaving wave
2 a failing acceptance test with no rule to fix it by.

The two candidate roots and their order are asserted by the law, and the
failure message names both attempts, so a red bar says what it tried rather than
only that it failed. The package-source-root list is **derived** from the
workspace, never hardcoded — a hardcoded list is the same rot class this PRD was
written about, one level up. An entry whose leading path is not inside any
package (`README.md`, `package-lock.json`, `scripts/gate.sh`, `.swarm/*`) has no
second attempt and therefore no shorthand: its citations are repo-relative or
they fail. A citation carrying a line or range suffix (`foo.sh:79-81`) is not a
path claim and is not checked here; the registry's existing cite-anchor-text-
never-a-line-number rule already governs those, and tightening that is a
separate decision.

**Answers Open question 1's sibling, not Open question 1.** Un-backticked prose
numbers remain unchecked and unruled.

## Ruling 6 — an entry may not quote a form that does not appear in the cited file, even to say it does not appear (settles ruling 2's absence edge)

**Verdict.** The construction is **refused**. This settles Ruling 2's *absence* edge (its
amendment note 1) and nothing else — the unit question raised by its amendment note 2 is a
separate wave-0 act and remains open. Ruling 2's check stays a plain
verbatim-occurrence test with no inversion, no marker and no exception: if a
reason backticks an assertion form, that form occurs in the cited file. A fact
about something being *absent* is stated in prose instead.

**Why.** The asymmetry with ruling 3's generated-path declaration is the whole
argument, and it is a real distinction rather than a preference:

- A **generated path** must be named to be useful. "The gate writes a count file
  under `.swarm/`" is not a substitute for `.swarm/timing-count` — the reader
  needs the name, and the name cannot be checked by existence, so a declared,
  asserted exception is the only way to carry it. Hence ruling 3.
- An **absent form** never needs to be quoted. Everything a reader needs can be
  said about what *is* there. #353's entry is the worked example: it went from
  quoting `` `.toBe(14)` `` to say that form is absent, to *"the pin is written
  against the constant and never against the literal"* — and the sentence got
  **shorter, truer and more useful**, because it names what the reader will
  actually find when they open the file.

So the exception ruling 2 could have granted would buy expressiveness the file
does not need, at the cost of the one property that makes the check worth having:
that a backticked form in a reason is always something you can grep for and find.
An entry whose quotations are sometimes assertions and sometimes anti-assertions
cannot be read at a glance, and a reader who greps a quoted form and finds
nothing would no longer know whether they had found rot or a footnote.

**Extent.** Applies to every backticked `.toBe(N)` / `.toHaveLength(N)` /
`.toEqual(…)` form in any reason — the same surface as ruling 2, unchanged. It
does **not** forbid *mentioning* a form in prose without backticks, which is how
an author who genuinely needs to name an absent spelling should do it; the law
checks backticked forms only. It does not extend to paths, which ruling 5 and
ruling 3 govern between them.

**Consequence for wave 2, stated so it is not discovered late.** With this
ruling, the law needs no absence machinery at all — no marker to parse, no
inversion branch, no allowlist. That is the point: ruling 4 exists to keep a
day-one allowlist out of this law, and the cheapest way to honour it is a rule
with no exception to allowlist.

## Ruling 7 — Extent selects, the body checks: the unit is the whole backticked span (settles ruling 2's unit edge)

**Verdict.** Ruling 2's **body** is the check; its **Extent** sentence is only a
*selector*. `.toBe(N)` / `.toHaveLength(N)` names which backticked spans are in
scope, and what must then occur verbatim in the cited file is **the whole span**,
matched as an exact substring. Extent is reworded from naming those forms to
*selecting* them, so the two sentences stop reading as rival checks. Ruling 2's
verdict is unchanged — the body already said "form".

**The selector also widens to any assertion call, symbolic as well as numeric.**
In scope is a backticked span containing `.toBe(`, `.toHaveLength(` or
`.toEqual(`, whatever its argument.

**Why, re-derived independently over all 21 entries on `main` at `5b9cc5e5`.**
The measurement in ruling 2's amendment note 2 was reproduced rather than
inherited, and it holds exactly:

| span, and the entry it sits in | span present? | token present? | |
|---|---|---|---|
| `` `.toBe(225)` `` — tokens.test.ts | no | no | readings agree |
| `` `expect(ROUTE_CLASSES.length).toBe(25)` `` — route-class-law.test.ts | no | **yes** | **disagree** |
| `` `expect(routes.length).toBe(25)` `` — route-class-law.test.ts | no | **yes** | **disagree** |

The decoy is `packages/server/src/api/route-class-law.test.ts:180`,
`expect(gatedFound.length).toBe(25)` — it counts *gated* routes, while the two
pins that entry describes stand at 30. So **the span reading reddens all three
false claims; the token reading reddens one.** Two of the three claims this PRD
exists to catch would pass, Success 4's own route-class example among them.

There is no false-positive surface to weigh against that: only **two** of the
21 entries carry a span in scope at all, and the remaining nineteen carry none.
The law therefore lands with no allowlist, which is ruling 4's point.

**Why the selector widens.** Under the numeric-only reading, ruling 2's own
prescribed remedy goes unchecked: an entry that cites its pin by symbol —
`` `.toBe(TEST_FILE_KNOWN_DEBT_COUNT)` ``, which is exactly what ruling 2 tells
an author to write when the value lives in a constant — falls outside `.toBe(N)`
and is checked by nothing. Widening closes that for free. EXECUTED: the widened
selector matches **four** spans across the registry — the three above, all of
which it reddens, and that symbolic one, which is present in its cited file and
passes. Zero false positives. A renamed constant is a live failure mode here,
not a hypothetical: this repo already records that a renamed symbol leaves a
green suite and a lying doc.

**Extent.**

- The span is matched as an **exact substring**, whitespace included, of the
  cited file's text. It is not normalised, and it is not parsed.
- Because the match is a substring of the file rather than of a line, a source
  assertion split across lines is still reachable **provided the quoted span
  itself sits within one line** of the source. Worked case:
  `prefix-comparison-law.test.ts:535` is `).toBe(TEST_FILE_KNOWN_DEBT_COUNT)`
  and the entry's span `` `.toBe(TEST_FILE_KNOWN_DEBT_COUNT)` `` matches inside
  it. A span that would have to cross a newline cannot match, and must be
  shortened to the part that does not.
- **An entry backticks only source text.** A span like `` `.toBe(25) twice` ``
  can never occur verbatim and would be a false positive of the author's own
  making; the count goes in prose beside the span, not inside it. All four spans
  in the registry today comply — verified, each is code-only.
- This ruling does not reach numbers or paths outside backticks. Prose numbers
  remain Open question 1, and paths are rulings 3 and 5.
- It does not settle which file is "the cited file" when a reason quotes a form
  belonging to another file it names. Ruling 2's amendment note 2 records that
  no entry does this today; it stays unfiled work.

**Falsifier.** If an entry is found that must quote a span crossing a newline in
the source — a genuinely multi-line assertion whose shorter forms are ambiguous
— the substring rule fails a correct claim, and the answer is to amend this
ruling, not to relax the law quietly into normalising whitespace. Normalising is
the move that would let `.toBe( 25 )` satisfy a claim about `.toBe(25)`, and the
whole value of the span reading is that it is literal.

**Consequence: this unblocks #367**, which is the last wave-0 act it waits on.
Wave 1 (#366) is unaffected — correcting the route-class entry does not settle
this edge, because line 180's decoy makes the token reading pass regardless of
what wave 1 writes.

## Sequencing (waves, each gated as ever)

*Groomed 2026-09-09, operator sign-off in session; written to what was groomed rather than to the
draft it replaced. Three deviations from that draft, each deliberate: the `.swarm/timing-count`
declaration moved from wave 2 into wave 1; wave 2 became one issue rather than three parallel
items; and the law also ports the shell script's presence checks. Reasons below.*

`.swarm/coupling.txt` is also [#353][i353]'s and [#358][i358]'s fence. [#353][i353] landed on
`main` as `4299adec`; [#358][i358] is still open, and wave 1 waits on it — all three edit that one
file, so they are sequential by construction rather than parallel. No wave enters
scripts/fence-lint.sh (Non-goals), and none enters `doc-citation-law.test.ts`, which is prd-17
territory.

**Wave 0 — operator acts, booked and not dispatchable. COMPLETE 2026-09-09.** Three items, all
answered, and no issue minted for any of them:

- Ruling 3's resolution edge — **answered**, as Ruling 5.
- Ruling 2's absence edge — **answered**, as Ruling 6.
- Ruling 2's *unit* edge — **answered**, as Ruling 7. Raised by Ruling 2's amendment note 2, from
  the independent review of `fa64a7a7`, after the other two were decided, and settled last: the
  span reading reddens all three false claims in the registry while the token reading reddens one,
  so the token reading would have passed two of the three claims this PRD exists to catch —
  Success 4's own route-class example among them.

All three edges were found the same way — by auditing an entry against a ruling rather than by
writing code to it — and two of the three by a reader other than the ruling's author. That is the
argument for the audit step wave 2's law replaces, and the reason wave 2 should not start until
someone has audited the remaining entries against Rulings 5, 6 and 7 as well.

**Wave 1 — the Keystone: the registry's own claims are true.** [#366][i366]. Claimed by nobody
downstream but the law that checks it. One file, `.swarm/coupling.txt`:

- the `tokens.test.ts` entry — `.toBe(225)` becomes the `RAW_PIXEL_SIZES` symbol, today 0, with
  the both-directions framing re-stated honestly at zero;
- the `route-class-law.test.ts` entry — its two `.toBe(25)` spans re-derived from the file, which
  pins 30. Note that this entry is the one Ruling 2's unit edge turns on, and correcting it does
  not settle that edge: `api/route-class-law.test.ts:180` carries an unrelated `.toBe(25)` that
  makes the token reading pass a stale claim regardless of what this wave writes;
- the `.swarm/timing-count` generated declaration, with `scripts/gate.sh` asserted as its
  generator. **Moved here from wave 2**, because the law arrives red without it: as drafted they
  were siblings in one wave, which is an intra-wave dependency and a stack wearing a bundle's
  clothes;
- the **three** citations Ruling 5 forbids, all of them in the `README.md` entry, expanded to
  repo-relative: the two cross-package shorthands `api/index.ts` and `cli/index.ts`, and the bare
  filename `manifest-law.test.ts`, which is `packages/app/src/host/manifest-law.test.ts` and
  resolves under neither of Ruling 5's attempts. All three sit inside this wave's one file, which
  is what makes Ruling 5 affordable. **The third was added after [#366][i366] was written**: the
  ruling's first draft counted nine path citations and this was the tenth, found in the review of
  the PR that landed the ruling. [#366][i366]'s Definition of done named two and said "Nothing
  else is expanded"; it has been corrected, and the law arrives red on this entry if it is not.

**Wave 2 — one issue, not a parallel set.** [#367][i367]. The law asserting Rulings 2, 3, 5, 6
and 7 over every entry, in a new file under `packages/server/src/`, **and** the pointer added to
`scripts/dev/coupling.test.sh` so the two cannot silently diverge. One issue rather than two lanes
because the pointer names the law's own filename, so they cannot be built at once. The law also
**ports the shell script's presence checks** — each entry's leading path exists, each reason is
present and not a repeat of its own path — so they run in CI rather than only by hand; that reads
Ruling 1's extent as covering registry checks while leaving its fence-lint behavioural cases in
shell, and Success 1 is not met while those checks run only when someone remembers them.
**Ruling 7 is the substantive half of that**, not a footnote to Ruling 2: it fixes the unit as the
whole backticked span and widens the selector, and the measurement in its own section is that the
span reading catches three of the registry's false claims where the token reading catches one. A
law built to Ruling 2 alone would pass two of the three defects this PRD was written about. This
sentence named four rulings until the review of the PR that added the fifth — Ruling 7 was
appended one commit after the sentence was written, and the sentence was not revisited.
**Blocked on wave 1 only, now that wave 0 is complete.**

**Unfiled work implied, described not numbered:** whether an entry's reason should be generated
from the law it describes rather than written beside it; a sweep of the other entries'
un-backticked prose claims, which no ruling here makes checkable; and a position on which file is
"the cited file" when a reason quotes a form belonging to another file it names — Ruling 2's
amendment note 2 records that no entry does this today.

## Open questions

1. **Does a number outside backticks need checking too?** [#353][i353]'s entry says "14 today
   across seven files", none of it backticked, and Ruling 2 does not reach it. Requiring
   backticks around every checkable number would — at a cost in readability. **Open, not ruled.**
2. **Should the law fail, or warn, when a cited file no longer trips its own detector?** That is
   the strongest check available — `prefix-comparison-law.test.ts` already does it for its own
   allowlist — and may be too expensive to generalise. **Open, not ruled.**

[i353]: https://github.com/launchpad-26/rhizomorph/issues/353
[i358]: https://github.com/launchpad-26/rhizomorph/issues/358
[i366]: https://github.com/launchpad-26/rhizomorph/issues/366
[i367]: https://github.com/launchpad-26/rhizomorph/issues/367
