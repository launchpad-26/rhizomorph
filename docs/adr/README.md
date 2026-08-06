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

The notes were restored in `d1b7562`, which is the cheaper lesson: **the evidence
behind a decision is not a process artifact.** Keep the spike, or write the ADR
before you delete it.

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

| # | Decision | Decided | Status |
|---|---|---|---|
| [0001](0001-read-only-observer-as-a-constitution.md) | Read-only observer, amendable only by explicit invocation | 2026-07-30 | accepted, amended ×2 |
| [0002](0002-one-reducer-for-live-and-replay.md) | One event log, one reducer, serving both live and replay | 2026-07-30 | accepted |
| [0003](0003-core-is-browser-safe.md) | `core` is browser-safe: zod only, no `node:*` | 2026-07-30 | accepted |
| [0004](0004-collector-contract-over-an-exec-seam.md) | Collectors are pure folds over command output, behind an injected `Exec` | 2026-07-30 | accepted |
| [0005](0005-session-log-lives-outside-the-watched-repo.md) | The session log lives outside the watched repo | 2026-07-30 | accepted |
| [0006](0006-canvas-2d-over-webgl.md) | Canvas 2D for the scene, with no 3D library | 2026-07-31 | accepted |
| [0007](0007-one-derived-fleet-object.md) | One derived `Fleet` object, four surfaces | 2026-07-31 | accepted |
| [0008](0008-localhost-only-single-origin-server.md) | Localhost-only, single-origin server with token-gated mutation | 2026-07-31 | accepted |
| [0009](0009-portable-hash-chained-record.md) | A session is one portable, hash-chained file — and there is no protocol | 2026-08-04 | accepted |
| [0010](0010-adapter-capabilities-named-not-ranked.md) | Every collector declares what it cannot do; the ladder is named, not ranked | 2026-08-05 | accepted |
| [0011](0011-recordings-never-rot.md) | Recordings never rot: lenient parse, reserved `upcast()`, golden era corpus | 2026-08-06 | accepted |

Every record above was reconstructed on 2026-08-06 and says so in its Context.
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
