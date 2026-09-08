# Architecture Decision Records

This explains what they are, why this repo keeps them,
and how to write one.

## What an ADR is

An **Architecture Decision Record** is a short document — usually under a page —
capturing one significant decision: what was decided, what else was considered,
and what it costs. One decision, one file. They're never edited once accepted;
when the decision changes, you write a new one that supersedes the old.

The practice comes from [Michael Nygard's 2011 post][nygard], and the idea is
narrower than "documentation". An ADR doesn't describe how the system works —
`docs/architecture.md` does that. It records **why the system is shaped this
way, and what we gave up to get it.**

## Why bother

Two failure modes, both named in the literature, and both cheap to recognise
once you've seen them:

- **Groundhog Day** — a decision gets re-litigated every few months because
  nobody remembers why it was made. The argument runs again from zero.
- **Email-Driven Architecture** — the reasoning existed once, in a Slack thread
  or a PR comment or someone's head, and is now unrecoverable.

Both have the same root: the *decision* survived in the code, but the *reasoning*
didn't. Code shows you what was chosen. It cannot show you what was rejected, or
why — and that's the part you need when someone proposes changing it.

This repo learned that the hard way. A dozen research spikes were written while
decisions were being made, then deleted as "process artifacts" in `676faad`. The
decisions survived in the code; the rejected options went with the files, and
nine PRDs were left citing notes that no longer existed. Every ADR here was
reconstructed from git history because of it.

The cited notes were restored in `d1b7562`, and the rest re-pruned in `ddf2693`.
That settled a rule worth keeping:

> **Keep a research note if a surviving document cites it. Git holds the rest.**

The original prune deleted by *category* — "process artifacts" — which is why it
took cited and uncited alike and left nine PRDs asserting things on evidence
nobody could reach. Deleting by *reachability* cannot do that. Either keep the
spike, or write the ADR before you delete it.

## What is, and isn't, an ADR

The test is simple and worth applying honestly:

> **If you can't name at least one alternative that was rejected, and say why,
> it isn't an ADR.**

That usually means it's one of these instead:

| It's really… | Where it goes |
|---|---|
| Rationale for a value, formula, or visual form | `docs/design-notes/` |
| A product or scope ruling | a PRD in `docs/prds/` |
| An investigation or measurement | a proposal / spike |
| How the system currently works | `docs/architecture.md` |

ADRs are for decisions that are **architecturally significant** — they shape
structure, constrain future work, or would be expensive to reverse. Package
boundaries, data formats, contracts between subsystems, where authority lives.
If reversing it is a weekend, it probably isn't one.

**In this repo specifically:** a PRD *ruling* decides product scope and behaviour
and dies with its PRD. An ADR decides structure that outlives the PRD. When a
ruling is architectural, the PRD should link to the ADR rather than restate it.

## The template

We use [MADR][madr] **minimal**. Copy this:

```markdown
# NNNN. Short title as a noun phrase

- **Status:** proposed | accepted | rejected | deprecated | superseded by ADR-NNNN
- **Date:** YYYY-MM-DD

## Context and Problem Statement

What forces are at play? Written neutrally — someone who disagrees with the
outcome should still accept this section as fair.

## Considered Options

- Option A
- Option B
- Option C

## Decision Outcome

Chosen: **Option B**, because …

Then say why the others lost. This is the most valuable part of the record —
it's the part that stops the decision being re-argued from zero.

## Consequences

- Good: …
- Bad: …
- Neutral: …

Include the bad ones. A record with no downsides is not a decision, it's an
advertisement.
```

For a genuinely contested decision, the [full MADR template][madr-templates] adds
Decision Drivers, per-option pros and cons, and a Confirmation section (how you'd
verify the decision is actually being followed). Use it when the extra structure
earns its keep; default to minimal.

## Conventions

**Naming** — `NNNN-title-with-dashes.md`, zero-padded, sequential.
Numbers are never reused, including by rejected records. The number becomes a
citable identifier: `ADR-0007` in a code comment or PR is unambiguous forever.

**Status** — `proposed`, `accepted`, `rejected`, `deprecated`, or
`superseded by ADR-NNNN`.

**Append-only.** This is the rule that makes the log trustworthy: **never edit an
accepted ADR's decision.** Changed your mind? Write a new ADR, and set the old
one's status to `superseded by ADR-NNNN`. Keep the old file. A superseded ADR
isn't clutter — it's the record of a road that was taken and then left, which is
exactly what stops it being taken again by accident.

Fixing a typo or a broken link is fine. Rewriting the reasoning is not.

**Amendments are new top-level ADRs.** Some decisions here are constitutions
rather than one-off choices — ADR-0001 is the clearest — and they get *amended*
rather than superseded: the old decision still stands, with a named power added
to it. There is exactly one numbering scheme for that, the sequential one above.
An amendment gets the next free number, states in its own Decision Outcome that
it amends ADR-NNNN, and the amended record's **Status** line gains a link to it.
Sub-numbers (`0001a`) are not a convention here.

This was ambiguous until 2026-08-10, and worth recording rather than quietly
fixing. ADR-0001's Status line read *"amended by ADR-0001a and ADR-0001b"* from
the day the log was reconstructed (`752748a`), and **neither file was ever
written** — the two amendments it means are items 2 and 3 of ADR-0001's own
Decision Outcome list, each with its commit. So the log simultaneously implied
three different conventions: sub-numbered records, list items inside the amended
ADR, and (by its own naming rule) new top-level records. ADR-0019 is the first
amendment written as a file, and it asserts the third reading. ADR-0001's
dangling reference was repaired as a broken link — the append-only rule's
explicit exception — and its reasoning was not touched. The first two amendments
were **not** retrofitted into records of their own: back-dating two ADRs to tidy
a convention would be exactly the rewrite this section forbids.

**A falsified consequence gets a dated note in place; a changed decision still
gets a new ADR** *(ruled 2026-08-24)*. The distinction is the whole point. A
record's **Decision** and its **Considered Options** are history and never move —
that is the append-only rule above. But a record's **Consequences** are claims
about the tree, and the tree changes underneath them: five records here spent
weeks asserting open holes that had been closed, ADR-0008 among them, which is
the security document a reader consults to learn what is *not* protected. Those
were corrected by appending a `> **Amendment — <what> (<date>)**` blockquote
directly under the falsified consequence, saying what closed it and citing the
code or law that proves it, leaving the original text intact above. This is not a
licence to revise reasoning: if the *decision* would change, that is a new ADR
with the next free number, exactly as the paragraph above requires. Records
amended this way so far: 0001, 0002, 0007, 0008, 0011, 0019.

## Writing an honest one

Named anti-patterns worth knowing, from [Zimmermann's guidance][ozimmer-create]:

- **Fairy Tale** — only upside, no real trade-offs. The most common one.
- **Sales Pitch** — marketing language in place of evidence.
- **Dummy Alternative** — a strawman option listed to fake rigour. If Option C
  was never seriously on the table, don't pad the list with it.
- **Mega-ADR / Novel-Epic** — the record grows into a full design document. If
  it's more than about two pages, something in it belongs elsewhere.

And when reviewing one, [the review-side failures][ozimmer-review] are mostly
**Pass Through** (skimmed, rubber-stamped) and **Copy Edit** (commenting on
grammar instead of on the decision).

## Reconstructed ADRs

Some records here were written *after* the fact, from git history and deleted
research notes, because the decisions were real and undocumented. This is
legitimate practice — [Microsoft's guidance][ms-adr] explicitly recommends
retroactively generating ADRs for existing systems where the evidence exists.

There's no standard convention for marking one, so ours is: **say so in prose in
the Context section** — the date it was written, the approximate date of the
original decision, and what it was reconstructed from. The file's own `Date` is
when the *record* was written, never a backdated guess. A reconstructed record
should also be explicit about which parts are cited and which are inferred.

## Index

Numbered by when the decision was *made*, not when the record was written — the
whole log was reconstructed in one pass on 2026-08-06, so allocation order would
have carried no information.

**The column is not sorted, and 0032 is the widest inversion, deliberately.**
0032 records a decision made 2026-08-04 and was written 2026-09-03, so it takes
the next free number rather than one matching its date — numbers are never
reused and the log is append-only, which outranks keeping this column sorted.
It is not the first inversion: 0019 (decided 2026-08-10) sits after 0017 and
0018 (both 2026-08-13), and 0022 (2026-08-14) after 0021 (2026-08-15). Read the
**Decided** column, not the number, when order matters. Any later reconstruction
of an old decision will do the same thing.

| # | Decision | Decided | Status |
|---|---|---|---|
| [0001](0001-read-only-observer-as-a-constitution.md) | Read-only observer, amendable only by explicit invocation | 2026-07-30 | accepted, amended ×4 (latest: [0020](0020-transcript-migration-is-a-create-only-copy.md)) |
| [0002](0002-one-reducer-for-live-and-replay.md) | One event log, one reducer, serving both live and replay | 2026-07-30 | accepted, one consequence amended (2026-08-24: the fold-order defect is resolved) |
| [0003](0003-core-is-browser-safe.md) | `core` is browser-safe: zod only, no `node:*` | 2026-07-30 | accepted |
| [0004](0004-collector-contract-over-an-exec-seam.md) | Collectors are pure folds over command output, behind an injected `Exec` | 2026-07-30 | accepted |
| [0005](0005-session-log-lives-outside-the-watched-repo.md) | The session log lives outside the watched repo | 2026-07-30 | accepted |
| [0006](0006-canvas-2d-over-webgl.md) | Canvas 2D for the scene, with no 3D library | 2026-07-31 | superseded by [0021](0021-webgl2-for-the-living-scene.md) |
| [0007](0007-one-derived-fleet-object.md) | One derived `Fleet` object, four surfaces | 2026-07-31 | accepted |
| [0008](0008-localhost-only-single-origin-server.md) | Localhost-only, single-origin server with token-gated mutation | 2026-07-31 | accepted |
| [0009](0009-portable-hash-chained-record.md) | A session is one portable, hash-chained file — and there is no protocol | 2026-08-04 | accepted |
| [0010](0010-adapter-capabilities-named-not-ranked.md) | Every collector declares what it cannot do; the ladder is named, not ranked | 2026-08-05 | accepted |
| [0011](0011-recordings-never-rot.md) | Recordings never rot: lenient parse, reserved `upcast()`, golden era corpus | 2026-08-06 | accepted |
| [0012](0012-in-band-capability-token-delivery.md) | Deliver the capability token in-band, via a `<meta>` tag in `index.html` | 2026-08-08 | accepted |
| [0013](0013-collector-ticks-are-bounded.md) | Every collector tick is bounded: a default exec timeout and a loop-level watchdog | 2026-08-10 | accepted |
| [0014](0014-exhaustive-route-classification.md) | Every route is declared into one of three classes, checked by walking the running app | 2026-08-12 | accepted |
| [0015](0015-agent-removed-is-an-event.md) | Agent removed is an event, not a silent gap | 2026-08-12 | proposed |
| [0016](0016-prunable-not-enoent-proves-a-worktree-gone.md) | A worktree is proven gone by git's own `prunable` flag, not by probing for ENOENT | 2026-08-12 | accepted |
| [0017](0017-one-turngrammar-seams-shape-and-extraction.md) | One `TurnGrammar` seams turn shape and extraction, not two | 2026-08-13 | accepted |
| [0018](0018-bare-path-body-shape-routing.md) | The OTLP receiver adds one bare-path route, dispatched by body shape | 2026-08-13 | proposed |
| [0019](0019-the-fourth-hand.md) | The concierge: a fourth hand, granted two powers by explicit invocation — amends [0001](0001-read-only-observer-as-a-constitution.md) | 2026-08-10 | accepted |
| [0020](0020-transcript-migration-is-a-create-only-copy.md) | Transcript migration is one create-only copy into the watched repo's slug directory — amends [0001](0001-read-only-observer-as-a-constitution.md), extends [0019](0019-the-fourth-hand.md) | 2026-08-14 | accepted |
| [0021](0021-webgl2-for-the-living-scene.md) | WebGL2 for the living scene, superseding canvas 2D — supersedes [0006](0006-canvas-2d-over-webgl.md) | 2026-08-15 | accepted |
| [0022](0022-per-worktree-incidents-are-worktree-facts.md) | Per-worktree incidents are recorded on the worktree, not the collector | 2026-08-14 | accepted |
| [0023](0023-a-transcript-dialect-names-itself-with-harness.md) | A transcript dialect names itself with `harness`, not a new source literal | 2026-08-15 | accepted |
| [0024](0024-a-gated-read-is-the-fourth-route-class.md) | A gated read is the fourth route class, and "gated" fails the build when it is fiction — amends [0014](0014-exhaustive-route-classification.md) | 2026-08-17 | accepted |
| [0025](0025-a-native-otlp-harness-gets-a-mapping-profile.md) | A harness that exports OTLP natively gets a mapping profile, not a collector | 2026-08-18 | accepted |
| [0026](0026-the-shell-is-driven-by-playwright-not-certified-by-hand.md) | The desktop shell is driven by Playwright for visual certification, not certified by hand | 2026-08-21 | accepted |
| [0027](0027-the-served-page-declares-its-own-security-policy.md) | The served page declares its own security policy | 2026-08-21 | accepted |
| [0028](0028-bounded-lru-cache-for-parsed-session-logs.md) | A bounded, single-flight, mtime+size-validated cache for parsed session logs | 2026-08-24 | accepted |
| [0029](0029-a-recording-may-repeat-a-fact.md) | A recording may repeat a fact: at-least-once on the poll path, no read-side dedupe — amends [0011](0011-recordings-never-rot.md) | 2026-08-25 | accepted |
| [0030](0030-the-alarm-may-outrun-the-record.md) | The alarm may outrun the record: the degrade `collector.error` is emitted whether or not its own append lands | 2026-08-26 | accepted |
| [0031](0031-the-recorder-hands-out-a-frozen-fold.md) | The recorder hands out a frozen fold: deep-frozen on assignment, return type unchanged | 2026-08-26 | accepted |
| [0032](0032-synthesized-sessions-live-in-the-harness-projects-tree.md) | A synthesized session lives in the harness's own projects tree, widening the lab's write surface by one named root — narrows [0005](0005-session-log-lives-outside-the-watched-repo.md) | 2026-08-04 | accepted (reconstructed 2026-09-03), context corrected 2026-09-04 |
| [0033](0033-the-record-travels-by-protocol.md) | The record travels by a versioned protocol, keyed on position — amends [0009](0009-portable-hash-chained-record.md) | 2026-09-03 | accepted |
| [0034](0034-the-fifth-hand.md) | The fifth hand: the shipper has a clock and holds one key, bounded — amends [0001](0001-read-only-observer-as-a-constitution.md) and [0019](0019-the-fourth-hand.md) | 2026-09-03 | accepted |
| [0035](0035-the-watcher-is-never-a-container.md) | The watcher is never a container; the team server always is | 2026-09-03 | accepted |
| [0036](0036-a-beacon-is-a-line-in-a-watched-directory.md) | A beacon is one JSON line appended to a rhizomorph-owned directory and tailed by a collector — never a route; the event carries the occurrence and a digest, the file keeps the content | 2026-08-24 | accepted (prd-27 ruling 1 / prd-17 ruling 2, recorded on the build #217) |
| [0037](0037-agent-status-names-its-witness.md) | `agent.status` names its witness: a pinned envelope source widens to a second literal, and an inference may not withdraw a declared summons | 2026-09-05 | accepted (prd-27 ruling 2, recorded on the build #281) |
| [0038](0038-a-summons-raiser-judges-the-fold-on-the-tick.md) | A summons raiser reads `buildFleet`'s own folded pathologies on the poll loop's tick and edge-triggers `summons.raised`/`summons.cleared`, keyed on `(lane, kind)` — never a collector, since the collector contract never hands folded state | 2026-09-06 | accepted (prd-17 ruling 5, ruled by the operator 2026-09-05) |
| [0039](0039-attention-names-its-witness-on-the-manifest.md) | `attention` names its witness on the capability manifest — L2 is told from L4 by who declared, not by rank — extends [0010](0010-adapter-capabilities-named-not-ranked.md) | 2026-09-06 | accepted (prd-27 ruling 3, recorded on the build #218) |
| [0040](0040-a-mark-that-is-already-a-control-still-discloses.md) | A mark that is already a control still discloses, without a second button — `Disclosure` gains a `trigger` mode (`'button'` / `'inline'`) so a chip, row or action button can carry a card without nesting a button inside a button | 2026-09-07 | accepted (prd-30 ruling 1 and charter §6, recorded on the build #220) |
| [0041](0041-a-saved-comparison-is-a-sidecar-not-an-event.md) | A saved comparison is a sidecar artefact beside the recordings, not an event in the log | 2026-09-08 | accepted (prd-14 ruling 5) |
| [0042](0042-the-server-parses-a-comparison-artifact-with-its-own-copy.md) | The server validates a comparison artifact with its own copy of the parser, not a shared schema | 2026-09-08 | accepted |
| [0043](0043-card-chrome-is-prose-on-hover-not-a-menu.md) | Card chrome is prose on hover, not a menu — the one-card law's definition widens to any positioned panel opened on hover or focus whose content is prose, so a menu of controls is out by definition rather than by exception | 2026-09-09 | accepted (prd-30 S1 acceptance, recorded on the build #221) |

Records 0001–0011 were reconstructed on 2026-08-06 and say so in their Context.
One, **ADR-0003**, has an inverted evidence shape worth knowing about: the
decision itself is inferred from construction, while every rejected alternative
is cited from code comments. **ADR-0008** deliberately excludes the SSE-vs-
WebSocket transport choice, because no deliberation of it survives — by this
log's own test, that is not a decision it can honestly claim to record.

---

[nygard]: https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
[madr]: https://adr.github.io/madr/
[madr-templates]: https://adr.github.io/adr-templates/
[ozimmer-create]: https://ozimmer.ch/practices/2023/04/03/ADRCreation.html
[ozimmer-review]: https://ozimmer.ch/practices/2023/04/05/ADRReview.html
[ms-adr]: https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record
[adr-org]: https://adr.github.io/
[jph]: https://github.com/joelparkerhenderson/architecture-decision-record

**Further reading:** [adr.github.io][adr-org] is the community hub (templates,
tooling, practices). [joelparkerhenderson/architecture-decision-record][jph] is a
large collection of examples and template variants.
