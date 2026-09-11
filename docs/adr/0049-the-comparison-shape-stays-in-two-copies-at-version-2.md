# 0049. The comparison shape stays in two copies at version 2, and the criterion is re-decided rather than obeyed

- **Status:** accepted (prd-14 ruling 6, ruled 2026-09-11)
- **Supersedes:** [ADR-0042](0042-the-server-parses-a-comparison-artifact-with-its-own-copy.md)

## Context and Problem Statement

ADR-0042 chose a hand-ported second parser over a shared schema, and deferred
the question with a trigger rather than a criterion:

> It is the right move the day a third consumer appears or a `version: 2` is
> written — and that day it is a new record, superseding this one.

prd-14 ruling 6 writes a `version: 2`. The trigger has fired, so this record
exists either way. The question it must answer is whether the trigger was
naming the thing that actually mattered.

## Considered Options

- **A — Obey the trigger: move the shape to `packages/core`,** import it from
  both packages, one definition.
- **B — Re-decide the criterion and keep two copies,** recording what would
  change the answer.
- **C — Put the shape in `packages/contract`,** where the two packages already
  meet.

## Decision Outcome

Chosen: **B.**

**The trigger stood proxy for a risk, and the risk is now covered elsewhere.**
ADR-0042's own Consequences named it exactly: *"two parsers of one shape. A
version bump lands in two files, and drift between them is a defect no law
currently catches."* That sentence was true when written and stopped being true
in #376, which built the thing it said did not exist — a shared fixture set both
parsers read, and an agreement law on each side asserting the same bytes produce
the same outcome, the same message and the same error class. Drift between the
copies is now a red suite rather than an undetected defect.

So a `version: 2` is no longer the moment the argument collapses. Moving the
shape today would buy one definition at the cost of a real seam: `packages/web`
is a Vite/React package the server has no business resolving, and the reason
`packages/contract` exists is that the two packages meet only through `buildApp`
and real HTTP shapes.

**A lost** on the same grounds ADR-0042 gave, which have not changed, plus one
the trigger did not anticipate: `packages/core` is the fold's home, and
[ADR-0041](0041-a-saved-comparison-is-a-sidecar-not-an-event.md) puts a saved
comparison deliberately outside the fold and off the record. Moving the shape
into `core` would site a sidecar's definition inside the module whose job is
the record it is not part of.

**C lost** because `packages/contract` is `"private": true` — a test package.
A production shape cannot live in a module that does not ship.

## Consequences

- Good: the version bump lands in two files, and the agreement laws fail if
  only one of them moves. That is the property ADR-0042 wished for and did not
  have.
- Good: the browser artifact format stays in the compare surface's own
  vocabulary. Ruling 6 stores `{ verdict, detail?, cost, duration, commits }`
  per run and the measure and gate provenance per artifact — facts, not
  `LabRunOutcomeDTO` — so no server type crosses into a stored browser format.
- Bad: two copies remain two copies. A reader still has to know both exist, and
  the agreement laws are the only thing making that safe.
- **The falsifier, and it is the point of this record.** This decision holds
  only while the agreement laws catch a one-sided change. That needs TWO kinds
  of coverage, and the first draft of this record named only one:

  1. **Throw-site coverage, derived from source.** The laws scan `artifact.ts`
     for its own construction sites and require a fixture for each, so a new
     throw with no fixture reddens the day it is added. Replace that derivation
     with a hand-maintained list and the protection becomes something someone
     must remember.
  2. **Accepted-value coverage.** Site coverage is not value coverage, and
     assuming otherwise was an error in this record's first draft — corrected
     here before it shipped, after two independent review passes each defeated
     it from a different angle. **Narrowing a union removes no throw site and
     adds no message**, so nothing reads as uncovered and nothing goes
     unmatched. Measured on the v2 build: narrowing ONE copy's accepted
     measures from `cost|duration|commits|verified` to `cost|verified` left
     both agreement laws at 63/63 and the full suite at 9149 passed, while the
     two parsers had genuinely diverged. The same held for `provenance.source`,
     and for a finite-number guard applied to `cost` alone. The cause was that
     the shared fixture's accept cases only ever carried the values the first
     build happened to use.

  So the fixture must exercise every member of every union v2 admits, and both
  the finite and non-finite form of every numeric field — not merely one
  example per throw site. If either kind of coverage lapses, the argument above
  is void and the shape should move, under a new record superseding this one.
- Deliberately not re-decided here: whether an upcast should exist. Ruling 6
  rules it out for v1 → v2 on the ground that the translation is not total —
  the measure is unrecoverable from a v1 artifact — and that is a property of
  those two versions, not a standing policy.
