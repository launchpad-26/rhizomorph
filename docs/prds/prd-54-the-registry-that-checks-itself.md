# prd-54 — the registry that checks itself: an unenforced check is not a check

> **Status:** **BLESSED** — ciaran-slow, 2026-09-08, in session. Milestone `prd54`. Written out of the review of
> [#353][i353], which registered one coupling point and found in passing that the registry it
> writes into is unverified prose, and that the script written to verify it is wired to nothing.
> Four waves and a correction that has already had to run twice: the first pass
> (#366) made the registry true on 2026-09-10, and eleven claims were false again by
> 2026-09-15. The second pass is this PRD's own thesis measured against itself.

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
- **The correction rots at the speed of the tree, which is the argument for the law and
  not against the correction.** Measured on `main` at `1c6f3852` (2026-09-15), five days
  after wave 1 landed as `22a42739`: **47** entries, up from 21. Of the **12** assertion
  spans Ruling 7 selects, **5** no longer occur verbatim in their cited file — the
  route-class pins moved from 30 to 34 on 2026-09-11 (#412), the very entry wave 1 had
  just re-derived; the contract-coverage law's gated-read count moved from 16 to 19 and
  its exclusion list from three routes to one on 2026-09-10 (#214); and the team API
  entry quotes a `toEqual` array the source writes across seven lines. Of the **58**
  path citations Ruling 8's clauses admit (54 by clause 4a, 3 by 4b, 1 by 4c), **50**
  resolve in a fresh checkout and 8 do not: the two declared-generated occurrences of
  `.swarm/timing-count`, and six correct claims the selector was never shown — see
  Ruling 9. `scripts/dev/coupling.test.sh` itself stands at 10 of 11: the `docs/adr/`
  entry (added 2026-09-11, #414) names its own path inside a command, and the script's
  "no reason" heuristic is *contains*, not *equals* — see Ruling 10. Every one of those
  eleven claims was committed through a green suite, a green typecheck and a green lint.

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
  asserts and records as deliberate, nor the two coupling entries [#358][i358] owed — which
  landed on `main` as `b5d6630c`, and were never this PRD's to write.

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
under ruling 3. What *resolves* means is not settled here — Ruling 8's Extent
part two carries the predicate these two attempts feed, and carries it only
there, so that the two cannot drift apart.

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

— **SUPERSEDED (operator, 2026-09-10) by Ruling 8**, which replaces this
paragraph's selector with four mechanical clauses, gives the count a stated
scope, and states the resolution predicate this ruling's own Verdict left
unsaid. The reasoning above stands and is why a selector belongs in a ruling at
all; the selector itself was wrong. Its second clause has no test for looking
like a filename, so it is satisfied by every backticked identifier in the
registry. Its exclusion sentence is right about the four spans it names — all
four are excluded, three of them on the leading dot and `` `*.bench.test.ts` ``
on the glob — and wrong in implying those are the only spans in the registry
that cite nothing. Under the scope Ruling 8 states (entry reason text, every
occurrence), the literal reading admits **46 of the 62** spans on `b1a6dae5`,
the tree this ruling was written against, and **76 of the 96** on `main` at
`df494011`; the large majority of both are not paths. Ruling 8 carries
the replacement and the measurement; this paragraph is left in place because the
argument for naming a selector is unchanged and because the failure is the
instructive part.

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

*Amendment note, 2026-09-15.* The multi-line case arrived and the falsifier did **not**
fire. The `packages/team/src/api/api.test.ts` entry quotes
`` `expect(storage.committed).toEqual(['0001_events', '0002_projections', '0003_roles_rls', '0004_events_dedup'])` ``
on one line; the source writes that assertion across seven, so the span can never match.
The shorter form the Extent prescribes — `` `expect(storage.committed).toEqual([` `` — occurs
exactly once in the file and is unambiguous, so the remedy is to shorten the span and
name the five migration ids in prose, and the rule stands as written. Recorded because it
is the first time the case has been met, and so that the next reader knows it was
checked rather than assumed.

**Consequence: this unblocks #367**, which is the last wave-0 act it waits on.
Wave 1 (#366) is unaffected — correcting the route-class entry does not settle
this edge, because line 180's decoy makes the token reading pass regardless of
what wave 1 writes.

## Ruling 8 — the path-citation selector is four mechanical clauses, the count has a stated scope, and *resolves* has a stated predicate (replaces ruling 5's Extent selector)

**Verdict.** Ruling 5's verdict — two resolution attempts, repo-relative then the
entry's own package source root — **stands unchanged**. What is replaced is the
sentence in its Extent that says *which spans the rule applies to*. A backticked
span in a reason is a path citation when **all four** hold:

1. it carries **no glob metacharacter** (`*`, `?`, `[`, `]`, `{`, `}`);
2. every character is in `[A-Za-z0-9._/-]` — so a span with a space, a
   parenthesis, a quote, a colon, `=`, `$`, `@` or `|` is not a citation;
3. it does **not** begin with `/` — a repo path is relative, and a leading slash
   means a URL route;
4. and **any** of these holds: it contains a `/`; **or** it does not begin with
   `.` and its final dot-separated segment is an extension **this repo actually
   tracks**; **or** the repo tracks a file whose **basename is exactly this
   span**.

The extension set in clause 4 is **derived from the tracked file list, never
written down** — the same rule ruling 5 already applies to its
package-source-root list, and for the same reason: a hardcoded list is the rot
class this PRD exists to prevent. Clause 4's **third** branch is derived from
that same list and exists for the dotfile: `` `.gitignore` `` is cited in the
`scripts/gate.sh` entry's reason, is tracked, and resolves repo-relative, but
has no `/` and begins with a `.`, so the first two branches reject it.
Measured on `main` at `df494011`: of the **twelve** dot-leading slash-free
occurrences in the registry, the third branch admits `` `.gitignore` `` and
**nothing else** — `` `.test.ts` ``, `` `.test.tsx` `` (twice), ``
`.startsWith('..')` `` (three times) and the rest stay rejected, because no
tracked file bears those names. The suffix exclusion that ruling 5's
leading-dot rule existed for therefore survives intact. **This branch was
added on review** (2026-09-10): the first three clauses were written against
`53e1325b`, where the `` `.gitignore` `` citation did not yet exist, and the
review that caught it swept the whole rejected set at both trees below to
establish it was the only one.


**And the count has a scope, which ruling 5 left unstated.** The population is
every backticked span in an **entry's reason text** — the part after the first `#`
on a line that is not itself a comment. The freestanding `# ── section ──`
comments between entries are **not** scanned. **Every occurrence counts, not every
distinct span:** a citation quoted twice is two citations, because each one has to
resolve.

**Why ruling 5's sentence had to be replaced rather than clarified.** It read: no
glob, and *either* a `/` *or* a bare filename not beginning with a `.`. The second
clause has no test for looking like a filename at all, so it is satisfied by every
backticked identifier in the file. It admits `Set`, `read`, `split`, `fail()`,
`import(`, a bare `)`, `vi.mock`, `ROUTE_CLASSES`, `route:`, `path.relative`,
`VAR=$(...)`, `|| fail`, and every `.toBe` / `.toHaveLength` assertion span in the
registry. The ruling claimed it excluded "the four backticked spans in the registry
that cite nothing". It does exclude those four — but they are nowhere near all of
them: on the tree that sentence was written against it admits **46 of 62** spans,
and on `main` at `df494011` **76 of 96**.

A law written to it would try to resolve `Set` and `)` as repo paths, fail on all
of them, and redden the registry on its first run — needing an allowlist of that
size on day one, which is exactly what **ruling 4** exists to prevent, and which
fails **Success 3**'s *"and the generated-file case does not false-positive"*
clause outright.

**MEASURED, twice, because the answer moves with wave 1 and saying only the
flattering number would be the defect this PRD is about.**

| measured against | admitted | resolve | do not resolve | rejected |
|---|---|---|---|---|
| `main` at `53e1325b`, wave 1 **not** landed | 15 | 11 | **4** | 75 |
| `main` at `df494011`, wave 1 landed (#366, PR #390) | 18 | 16 | **2** | 78 |

Every admitted span is a real path citation in both, and **not one of the
75/78 rejected is a path** — established not by inspection but by sweeping the
whole rejected set at both trees and resolving each span anyway: none of the
75 and none of the 78 resolve. That sweep is what found the `` `.gitignore` ``
case clause 4's third branch now admits; before it, one of the 79
then-rejected spans did resolve, and the claim in this paragraph was false on
the tree that lands.


The four that do not resolve at `53e1325b` are `manifest-law.test.ts`,
`api/index.ts`, `cli/index.ts` and `.swarm/timing-count` — which is to say the
rule reddens **exactly** the three citations wave 1 corrects, plus the
declared-generated one ruling 3 covers. That is the rule working rather than
failing, and it is independent corroboration that wave 1's scope was right: the
selector, written afterwards and without reference to that issue, picks out the
same three.

#390 has landed, as `df494011`, so the second row is the live state: the only
unresolved citations are the two occurrences of `.swarm/timing-count`, both
covered by ruling 3's declaration. So the rule fails **nothing** it should
pass and passes **nothing** it should fail. That is the bar ruling 5's
sentence could not meet.


**One more corroboration, and the strongest of them.** Run the same clauses
against `b1a6dae5` — the exact tree ruling 5's own Extent was written against,
21 entries — and they admit **exactly 10**, which is ruling 5's resolution table
line for line: 2 repo-relative, 4 under the entry's own package source root, 2
under another package's root, 1 that exists under neither
(`manifest-law.test.ts`), 1 nowhere (`.swarm/timing-count`). So ruling 8's
selector recovers ruling 5's *intended* population on ruling 5's own tree, which
is a better argument for it than the rejection counts are.

**Why not the obvious repair.** Requiring merely that a bare name "look like it has
an extension" — a dot followed by letters, read end-anchored, with clause 2 not
yet applied — still admits `vi.mock` and `path.relative`, because `mock` and
`relative` are dot-segments too. Measured on `main` at `53e1325b`: **19 admitted,
4 of them non-paths** — one `vi.mock` and three occurrences of `path.relative` —
against ruling 8's 15, all of which are paths. Read the extension shape as *any*
dot-followed-by-letters rather than end-anchored and it admits 34 instead, taking
in `path.isAbsolute(` and `path.posix.relative(` as well; those two are rejected
under the end-anchored reading, because neither ends in a dot-segment. Clause 4's
derived extension set is what separates `manifest-law.test.ts` from `vi.mock`, and
clause 2 is what removes the trailing-paren forms under either reading; neither
clause alone is sufficient.

**Extent.** The four clauses and the scope are asserted by the law, and its failure
message names which clause admitted a span it then could not resolve — a red bar
that says "clause 4b admitted this because `ts` is a tracked extension, and neither
attempt resolved it" is actionable, where "unresolved citation" is not. The clauses
apply only to path citations; ruling 7 governs assertion spans and is untouched,
and the two selectors are deliberately disjoint — clause 2 rejects every span
ruling 7 selects, because an assertion span always carries parentheses.

**Extent, part two — what "resolves" means, because these clauses feed a predicate
ruling 5 left as a judgement call.** Existence is `-e`, not `-f`: a citation that
names a **directory** resolves. Two of the eighteen admitted at `df494011` are
directories rather than files — `` `packages/` `` in the `scripts/gate.sh` entry, and
`` `shipper/` `` in the `packages/server/src/shipper/hand-law.test.ts` entry — and
both resolve, the first repo-relative and the second under the entry's own package
source root. This is not a new value: `scripts/dev/coupling.test.sh` already
presence-checks each entry's leading path with `[ -e "$path" ]`, and wave 2 below is
chartered to port that script's presence checks, so the law **inherits** this
predicate rather than picking one.

**Written down because it is load-bearing, and found the way clause 4's third branch
was** — by a pass that reimplemented these clauses from this text rather than auditing
them (review of PR #392, 2026-09-10). Resolve against the tracked *file* list instead
and the table above keeps both outer columns and moves both inner ones: **15 / 9 / 6 /
75** at `53e1325b`, and **18 / 14 / 4 / 78** at `df494011`. Three of this ruling's own
claims go false with them — that the four unresolved at `53e1325b` are exactly the
three citations wave 1 corrects plus the declared-generated one; that the only
unresolved at `df494011` are the two occurrences of `.swarm/timing-count`; and that the
rule fails **nothing** it should pass. A selector this mechanical resting on an
unstated predicate is ruling 5's defect one level down — the population was a
judgement call and so was the verdict — which is why the predicate is here rather
than with the law's author. It is also why the figures above reproduce ruling 5's own
resolution table at `b1a6dae5` line for line: that table already counted `` `packages/` ``
among its two repo-relative and `` `shipper/` `` among its four package-root citations,
so this predicate was the one in force when ruling 5 was written and is recorded, not
chosen, here.

**Its falsifier is the one ruling 5 already names.** A directory citation that resolves
is a claim that is *true and useless* when the reader meant a file inside it — the trap
"try every package root" was rejected for. So the rule is directory-permissive about
**existence** and says nothing about sufficiency: an entry that means a file cites the
file, and a reviewer may still say a directory citation is too loose to be worth
checking.

**Falsifier, and it is not hypothetical.** If a future entry needs to cite
something these clauses reject — a path with a space in it, a bare filename whose
extension this repo does not yet track, a deliberately quoted URL route — then the
rule fails a correct claim and **this ruling is what gets amended, not the law that
implements it**. Record the span on the wave-2 issue. The failure mode to refuse is
a law that grows a private exception list under a ruling that does not mention one:
that is ruling 4's day-one allowlist arriving late and by the back door.

The counting scope has its own falsifier: if the freestanding section comments ever
carry a citation that a reader would follow, the scope is wrong and should widen —
but widen it in this ruling, and re-measure, because three defensible scopes gave
three different answers when this was last counted and that is precisely why the
scope is now written down.

*Amendment note, 2026-09-15 — the falsifier fired, twice, and Ruling 9 answers it.*
Measured on `main` at `1c6f3852`, 47 entries: the four clauses admit **58** citations
(54 by clause 4a, 3 by 4b, 1 by 4c — the `` `.gitignore` `` case), of which **50** resolve
in a fresh checkout. Of the 8 that do not, two are the declared `.swarm/timing-count`.
The other six are correct claims of a shape this ruling was never shown:

| entry | span | what it actually is |
|---|---|---|
| `packages/core/src/eras/` | `` `session-state.snapshot.json` `` (4b) | a **family** — one file per era directory |
| `packages/server/src/shipper/key-mint-law.test.ts` | `` `init.sh` `` (4b) | a second mention of a file the entry earlier cites in full, from another package |
| `.swarm/prd-milestones.txt` | `` `done/` `` twice (4a) | once a shorthand for the archive directory, once a **grep target** with zero hits |
| `scripts/dev/prd-milestones.sh` | `` `done/` `` (4a) | a grep target with zero hits |
| `scripts/dev/prd-milestones.sh` | `` `prd-reconcile.sh` `` (4b) | a bare filename in an entry with no package root |

The selector is right about all six — each is path-shaped — and the resolution rule is
right too; what was missing is a rule for what an author may **put** in backticks. That
is Ruling 9. The clauses, the scope and the `-e` predicate are unchanged. The section
comment on line 24 carries a bare `` `.toBe()` ``; it is outside the stated scope and
stays so.

*Amendment note, 2026-09-16 — the falsifier fired a third time, from the other side.*
Wave 2's law made these clauses executable, and running them exposed a property the
ruling does not state: **the admitted set is derived from the tree it checks, so a
citation leaves the checked set when its target leaves the tree.** Renaming a cited
`.gitignore` away does not redden the entry that cites it — clause 4c admits a span only
if the repo tracks that basename, so the span silently stops being a citation. EXECUTED
during wave 2's fix re-review, with the control that makes the mechanism visible:
renaming only one of the two tracked `.gitignore` files leaves the other still tracked,
and the citation then reddens as an unresolved path. Clause 4b has the same shape and one
live span today, so it is not yet reachable there.

The clauses are **faithful to this ruling as written** — deriving the sets from the
tracked file list is what the ruling requires, and hardcoding them is the rot class it
exists to prevent. So this is recorded rather than fixed: a selector that narrows when the
tree narrows is the honest consequence of a derived population, and the alternative
(remembering a basename the repo no longer tracks) is a hardcoded list arriving by the
back door. What it costs is that deleting a cited file is invisible to the check that
cites it, which is the one direction this PRD's Success 3 does not cover. Left as a known
property; if it ever hides a real rot, amend here rather than patching the law.

## Ruling 9 — a backticked span cites one thing that exists; a search string, a family, or a second-hand shorthand is written another way (settles Ruling 8's first falsifier)

**Verdict.** Every span Ruling 8's clauses admit is a citation and is checked; nothing
admitted is exempt, and no marker exempts it. What changes is the author's side. Four
rules, one per shape the measurement found:

1. **A grep target is prose.** A string quoted for what it does *not* find — *"grep it
   for `done/`: zero hits"* — is Ruling 6's refused construction one surface over, and
   gets Ruling 6's remedy: say it without backticks. A backticked span in this file is
   always something a reader can open or find.
2. **A family is a glob or one member.** Files that exist once per directory —
   `session-state.snapshot.json` under each era — are cited as
   `` `eras/*/session-state.snapshot.json` `` (package-relative, since the entry sits in
   `packages/core/src/`) or by one member's full path. Clause 1 rejects a glob, so a
   family citation is **deliberately unchecked**; that is the honest reading of a claim
   about several files at once, and it is why the glob exclusion exists.
3. **A second mention is spelled like the first.** An entry that cites
   `packages/team/deploy/init.sh` in full and then says `` `init.sh` `` has written the
   same fact twice in two spellings, which is #649's one-edit rule. Under Ruling 5 the
   short form resolves only inside its own package root, and this entry's root is
   another package; so the second mention is the full path, or prose. Likewise
   `` `prd-reconcile.sh` `` in an entry with no package root is `scripts/dev/prd-reconcile.sh`.
4. **A moving literal stays quoted whole, and the registry becomes a coupling point for
   it.** The route-class and contract-coverage entries quote counts that move with every
   route. Quoting only the stable prefix — `` `expect(routes.length).toBe(` `` — would pass
   Ruling 7 forever while the number beside it in prose rotted unchecked, which is
   Success 2 inverted and the defect this PRD was written about. So the whole span stays,
   and the consequence is accepted and **declared**: once wave 2's law exists, a lane
   that moves a pin quoted in this file reddens `packages/server/` from a directory it
   never entered — exactly the shape every entry in this file describes. Wave 2 therefore
   adds the registry's **own** entry to the registry, naming the law, so that fence-lint
   warns the lane that moves a quoted pin. That lane fences `.swarm/coupling.txt` and
   reconciles the entry in the same commit that moves the pin.

**Why rule 4 is not the cheaper prefix.** Measured: two entries moved within 48 hours
of wave 1 re-deriving them (30→34 on 2026-09-11, 16→19 on 2026-09-10). Under the prefix
rule both would have stayed green with wrong numbers in prose beside them; under this
rule both redden, and the lane that moved the count is the lane told to fix the
sentence. The cost is one more file in a fence that already had to include the two laws
the entry describes.

**Extent.** Rules 1–3 are house style the law enforces only indirectly — a grep target in
backticks fails as an unresolved citation, which is the right verdict with the wrong
message; the law's failure text should therefore point here. Rule 4 is enforced by
Ruling 7 unchanged. Nothing here changes Ruling 8's clauses, scope or predicate. Prose
numbers remain Open question 1.

**Falsifier.** A file that genuinely must be cited as a search string a reader would
paste — not a claim of absence — would need a marker this ruling refuses. None exists in
47 entries. If one arrives, amend here, not in the law.

## Ruling 10 — a reason may name its own path; the presence check is equality, and a generated declaration names its generator as a path (settles Ruling 3's self-reference edge)

**Verdict.** The ported presence check is: the reason, trimmed, is **non-empty and not
equal to** the entry's leading path. *Contains* is not the test. An entry may name its
own path in its reason — `docs/adr/` legitimately says *"`git ls-tree origin/main
docs/adr/`"* — and `scripts/dev/coupling.test.sh`'s `*"$path"*` heuristic, which reads
that as "no reason given", is tightened to equality in this same wave, so the operator's
fast path and the law agree from the day the law lands.

**A generated declaration has one form.** Under Ruling 3 an entry declaring a path
generated writes, somewhere in its reason, exactly:

    `<generated-path>` is GENERATED by `<generator-path>`

The law reads that triple; the generated path is exempt from resolution, the generator
path must resolve under Ruling 5's two attempts, and the generator file's text must
contain the generated path. **The generator may be the entry's own leading path** —
`scripts/gate.sh` generates `.swarm/timing-count` and says so by name. Wave 1's wording,
*"its generator is THIS ENTRY'S OWN FILE"*, was written around the shell heuristic this
ruling retires, and is rewritten to the form above in this wave.

**Why equality.** The heuristic exists to catch an entry whose "reason" is the path
restated. Containment catches that and also every honest self-reference, and the
registry now has one; a guard that fails a true entry teaches its readers to expect red,
which is the header's own warning about warnings. Equality catches the case the guard was
written for and nothing else.

**Extent.** One form, no synonyms: the law matches the literal ` is GENERATED by ` between
two backticked spans and nothing looser, so that a declaration is as greppable as a
citation. Ruling 3's per-path, asserted, never-a-pattern rule stands. The shell script's
tightening is in this wave's fence, not wave 2's, because the ADR entry trips it today.

## Sequencing (waves, each gated as ever)

*Groomed 2026-09-09, operator sign-off in session; regroomed 2026-09-15 after the
registry was measured false again; wave 4 added 2026-09-16, operator sign-off in
session, after wave 2 landed as `219b5b56` and its own fix re-review found three
residuals in the repair. The 09-09 groom's three deviations from its draft
stand (the `.swarm/timing-count` declaration in wave 1; wave 2 as one issue; the law
porting the shell script's presence checks). The 09-15 regroom adds three more, each
recorded where it bites: wave 1 runs a second pass; wave 2 widens to the registry itself;
and a wave 3 that the tracker already carried is declared here.*

`.swarm/coupling.txt` was [#353][i353]'s and [#358][i358]'s fence, then wave 1's. All
landed on `main` — `4299adec`, `b5d6630c`, `22a42739` — and seventeen further commits
have edited the file since, none of them this PRD's. Every wave here edits that one file,
so the waves are sequential by construction. No wave enters `scripts/fence-lint.sh`
(Non-goals), and none enters `doc-citation-law.test.ts`, which is prd-17 territory.

**Wave 0 — operator acts, booked and not dispatchable.** Six items, all answered, no
issue minted for any of them. The first four were complete on 2026-09-10 and are
recorded as they were:

- Ruling 3's resolution edge — **answered**, as Ruling 5.
- Ruling 2's absence edge — **answered**, as Ruling 6.
- Ruling 2's *unit* edge — **answered**, as Ruling 7. The span reading reddens all three
  false claims in the registry while the token reading reddens one.
- Ruling 5's own *selector* — **answered**, as Ruling 8, on 2026-09-10. A law written to
  its Extent sentence would have reddened the file on its first run.

Three of those four were found by auditing an entry against a ruling; the fourth by
trying to implement one. Neither method dominates and wave 2 wants both — see the
2026-09-10 note that used to close this list, kept in the file's history at `d046fc30`.

The two added 2026-09-15 were found by a third method, which is the one the PRD argues
for: **running the rulings as code over the live registry** — not the law, a measurement
script — five days after wave 1:

- Ruling 8's falsifier fired on six correct claims of shapes it had not been shown —
  **answered**, as Ruling 9.
- Ruling 3's self-reference edge, first noted on [#367][i367] from building wave 1 —
  **answered**, as Ruling 10, together with the presence-check heuristic that made it an
  edge.

Both land with wave 1's second pass rather than in a PR of their own, at the operator's
request; the reasoning is at the head of the amendment that added them.

**Wave 1 — the Keystone: the registry's own claims are true.** Two passes.

*First pass, [#366][i366], landed 2026-09-10 as `22a42739`.* Corrected the tokens entry to
its symbol, re-derived the route-class pins, declared `.swarm/timing-count` generated, and
expanded the three `README.md` citations Ruling 5 forbids. Its Definition of done named two
expansions and then three; the third was found in review, and the miscount is recorded on
Ruling 5.

*Second pass, [#546][i546], regroomed 2026-09-15.* Eleven claims false on `main` at
`1c6f3852`, listed on the issue with the commit that moved each. Three commits, one per
kind of change, so each is reviewable alone: the PRD amendment carrying Rulings 9 and 10
and this section; the registry corrections written to them; and the shell script's
heuristic tightened to equality (Ruling 10). Ruling 4's extent holds — claims are
corrected and nothing else is added — with one named exception: the generated
declaration is rewritten to Ruling 10's form, which is a correction of shape, not a new
entry. The registry's own entry is **not** added here; it cites a file that does not
exist until wave 2, and Ruling 3 would redden it.

**Wave 2 — one issue, not a parallel set.** [#367][i367]. The law asserting Rulings 2, 3,
5, 6, 7, 8, 9 and 10 over every entry, in a new file under `packages/server/src/`; the
pointer added to `scripts/dev/coupling.test.sh` so the two cannot silently diverge; and —
widened at the 2026-09-15 regroom — the registry's **own entry** in `.swarm/coupling.txt`,
under Ruling 9 rule 4, naming the law so that fence-lint warns a lane that moves a quoted
pin. The law also ports the shell script's presence checks, as Ruling 10 states them.
**Ruling 7 is the substantive half of Ruling 2**, not a footnote to it, and **Ruling 8 is
the whole of the path selector** — a law built to Ruling 5's Extent sentence reddens the
file on its first run. Expected results on first run are re-derived from the tree it
lands on, never copied from a table here: the 2026-09-15 measurement is 47 entries, 12
assertion spans, 58 path citations, and the only unresolved citations after wave 1's
second pass should be the two declared occurrences of `.swarm/timing-count`. Any other
red is a finding, not an allowlist entry. **Blocked on wave 1's second pass only.**

**Wave 3 — the shell tests run without anyone remembering them.** [#394][i394], filed
2026-09-10 and homed here 2026-09-15; until then the tracker carried a wave this
document did not declare, which `prd-reconcile.sh` reports as drift. A law under
`packages/server/src/` discovers every `scripts/dev/*.test.sh` and executes it, so that
`coupling.test.sh` — and `lane-guard.test.sh`, which was red 2 of 18 on any clean checkout
with no mechanism by which anyone would learn it — run in the suite. Blocked on wave 2:
no shared path, but wave 2 edits one of the files this law executes, and the waves here
are sequential by construction. Its own body records what is out of scope; the
`.windows-known-failures` clause in its fence is conditional and is the only thing it
may touch outside the new file. **This is the wave the PRD's opening line did not
count.** Ruling 1 put the registry's checks in vitest because the suite is what runs; wave
3 is the same ruling applied to the shell tests the suite does not reach, and it is this
PRD's because #367's fence is the file that proved the point.

**Wave 4 — the law's own predicates are no weaker than the claims they stand for.**
One issue, plus one operator act. Wave 2 landed on `main` as `219b5b56` after three
review rounds; the third found three residuals in the repair itself, each reproduced
with a control and none a regression — they are strictly narrower than what round one
found, and they are recorded on [#367][i367] so a later reader can check them rather
than take this paragraph's word.

Two of the three are the same production wave 2's own repair was written to close: **a
predicate weaker than the claim it stands for.** `mentionsWholePath` seals the trailing
edge of ruling 10's generator check and leaves the leading edge open, so a generator
writing `cache.swarm/timing-count` still satisfies a declaration of
`.swarm/timing-count` — and since that path is the declared-generated one and does not
exist on disk, the generator check is the only guard behind its exemption from
resolution. The shell-agreement test's precondition proves the script *emitted a
summary*, not that it *examined any entries*, so a script reporting zero entries parsed
still passes on an empty-against-empty comparison. Both live in the law file, so they
are one issue and not two: two issues claiming that path is an overlap
`scripts/fence-lint.sh` hard-fails by construction.

That the same class survived the repair written to close it is the wave's whole
argument, and it is why the issue asks for the predicate table to be *completed and
asserted* rather than extended by two rows. Wave 2's table found a fourth instance the
review had not — the containment bound was missing at both resolution call sites, not
one — which is the evidence that enumerating beats patching here.

**The operator act, and it is not the wave's to make.** The third residual is a ruling
question wearing a defect's clothes. The registry's own entry, added by wave 2 under
ruling 9 rule 4, is the first **self-citing** entry this file has ever had: its leading
path is `.swarm/coupling.txt`, so ruling 7 checks its spans against the file they are
written in, and the span is satisfied by its own sentence. EXECUTED on [#367][i367]:
rewriting that span to a literal present in no source file anywhere leaves the law
green, while the identical rewrite on an ordinary entry reddens.

The Unfiled-work paragraph below carries the neighbouring question, recorded there with
the note that no entry does this and that the 2026-09-15 measurement confirmed it at 47
entries. **That note stopped being true when wave 2 landed** — it is corrected in place
below rather than left standing, since a stale "nobody does this" is exactly the rot
this PRD exists about. So the edge is live, and it wants a ruling before the law is
touched: whether a self-citing entry's spans are checked against something other than
themselves, whether such an entry may carry assertion spans at all, or whether the
construction is refused. Ruling 6 is the precedent worth reading first — it answered a
structurally identical question by forbidding the construction rather than by building
machinery for it, and the cheapest rule is still the one with no exception to allowlist.

Wave 4 shares no path with wave 3 and does not wait on it.

**Unfiled work implied, described not numbered:** whether an entry's reason should be
generated from the law it describes rather than written beside it; a sweep of the other
entries' un-backticked prose claims, which no ruling here makes checkable — and which
Ruling 9 rule 4 makes *more* numerous, since every as-of count beside a quoted pin is
one; and a position on which file is "the cited file" when a reason quotes a form
belonging to another file it names — Ruling 2's amendment note 2 recorded that no entry
did this, and the 2026-09-15 measurement confirmed it at 47 entries — **both were
overtaken when wave 2 added the registry's own entry, which cites itself**; see wave 4.

## Open questions

1. **Does a number outside backticks need checking too?** [#353][i353]'s entry says "14 today
   across seven files", none of it backticked, and Ruling 2 does not reach it. Requiring
   backticks around every checkable number would — at a cost in readability. **Open, not ruled.**
2. **Should the law fail, or warn, when a cited file no longer trips its own detector?** That is
   the strongest check available — `prefix-comparison-law.test.ts` already does it for its own
   allowlist — and may be too expensive to generalise. **Open, not ruled.**

3. **Should the law assert anything about an entry it checked nothing in?** Wave 2's law
   reports, per entry, how many backticked spans the selector saw and how many each ruling
   selected — and asserts only that the registry-wide totals are non-zero. Measured on the
   tree it landed on: **29 of 52 entries contribute no assertion span and no admitted path
   citation at all.** Every one is legitimate — their backticked spans are identifiers,
   shell fragments and a glob, which rulings 7 and 8 correctly decline — so the law is not
   wrong, but for those entries it asserts only that the leading path exists and the reason
   is not a restatement. [#367][i367]'s Definition of done asked for a law that fails "if an
   entry contributes no checked item at all and the law cannot say why"; what shipped
   asserts the per-entry count is an integer, which cannot fail. The question is which
   reading was meant: that presence *is* a checked item and the 29 are fully covered, or
   that an entry contributing nothing mechanical should have to say so. **Open, not ruled** —
   and worth noting the reporting is invisible either way, since this repo's vitest setup
   swallows `console.log` unless `--disable-console-intercept` is passed, which neither CI
   nor the landing gate does.

[i353]: https://github.com/launchpad-26/rhizomorph/issues/353
[i358]: https://github.com/launchpad-26/rhizomorph/issues/358
[i366]: https://github.com/launchpad-26/rhizomorph/issues/366
[i367]: https://github.com/launchpad-26/rhizomorph/issues/367
[i394]: https://github.com/launchpad-26/rhizomorph/issues/394
[i546]: https://github.com/launchpad-26/rhizomorph/issues/546
