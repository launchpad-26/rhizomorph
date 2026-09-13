# 0050. A third party generates a public wiki over this repo; the repo's own index is what it is generated from

- **Status:** accepted (operator ruling, 2026-09-14)
- **Date:** 2026-09-14

## Context and Problem Statement

This repository holds 260 tracked markdown files: 50 architecture decision
records, 55 PRDs across three shelves, 37 research notes, 27 design notes, seven
user-guide pages and a 2,962-line architecture narrative. Three of the nine
`docs/` subdirectories carry an index. The tree as a whole has none, and there are
two research trees that no document names together.

The audit at `docs/review/2026-09-14-documentation-audit.md` measured the
consequences. The relevant one here is not that any single document is wrong — it
is that a newcomer has no route in, and the documents that *are* wrong went
unnoticed for exactly as long as nobody had a reason to walk the tree.

DeepWiki (Cognition) indexes a public GitHub repository and generates a
navigable, queryable wiki from its code and documents, exposing the result both
as a web page and over a Model Context Protocol server that any agent can query.
The repository is public and MIT-licensed, so this costs nothing and requires no
credential. The question is not whether it is cheap. It is whether a derived,
publicly visible document about this repo — one that **none of this repo's 69
laws can redden** — is a thing this repo should have.

## Considered Options

- **A — Do nothing.** The tree stays unindexed and the drift the audit found stays
  as discoverable as it was, which is to say not.
- **B — Populate GitHub's own wiki.** The feature is already enabled on this repo
  and was never created: `git ls-remote` against the wiki remote answers
  `Repository not found`. It is a second place for prose to live, hand-maintained,
  outside the tree and therefore outside every law here. This repo's whole
  argument is that a claim nothing checks is a claim that goes false quietly.
- **C — An index in the repo, and nothing else.** One `docs/README.md`, held by a
  law, in the same idiom as the ADR log's index.
- **D — Self-host deepwiki-open.** MIT, Docker, and it wants model API keys. It
  produces a comparable artefact without a third party — at the cost of a service
  to run and a credential to hold. ADR-0019 rejected a hand that holds a
  credential on the grounds that *"a hand that holds a credential has something
  worth stealing"*, and ADR-0034 granted one only after a public argument and a
  law per clause. A documentation convenience does not earn that.
- **E — Index at deepwiki.com, keep the tree's own index as the source.**

## Decision Outcome

Chosen: **E, with C as its foundation rather than its alternative.**

The repo builds and holds its own index. The generated wiki is a *derived surface
over that index*, not a replacement for it. C is not rejected; it is the half that
this project owns, and it ships first.

**B is rejected** because a hand-maintained wiki outside the tree is prose no law
can reach, which is the failure this repo exists to refuse. **D is rejected** on
the credential, not on the concept; if the repo ever goes private, D becomes the
option to reconsider first. **A is rejected** by the audit's findings.

### What this costs, and the bound that makes it cheap

**Free and uncredentialed only while this repository is public.** That is the
whole basis of this decision, and it is not a permanent property.

If the repo goes private, all three clauses change at once: indexing requires a
Devin account; the free, unauthenticated MCP server no longer serves it and is
replaced by a credentialed one; and wiki generation above the default effort
level bills against a subscription. The vendor's own security documentation
states that customer data may be used for model training by default, with opt-out
available only on a paid plan.

**If this repository is ever made private, this record is superseded before the
wiki is re-indexed, not after.** A new ADR argues the credentialed case on its
merits, the way ADR-0034 argued the shipper's. Nothing about this decision carries
over automatically.

### What the repo does and does not promise about the generated page

It promises nothing. The page is written by a model from this tree, it is
refreshed on the vendor's schedule, and no test here can turn red when it is
wrong. Readers who need a claim they can rely on read the documents, which are
held by laws; the wiki is a way in, not an authority. The badge, the configured
endpoint and the repo slug they name **are** pinned by a law, because those are
the parts that live in this tree — a link that silently points at another project
is the failure mode a law can actually catch.

### Why the wiki is indexed last

A generated wiki is generated from what the repo says. At the time of this
ruling, the README claimed CI verification on every push for three platforms and
GitHub Actions had not run for two days — and the law guarding that section was
green, because it compares the README to a workflow file rather than to the
world.

Indexing first would have published that claim, restated in a model's voice, on a
page this project does not control and no law here can correct. So the
documentation corrections land first and the index is taken afterwards, as an
operator act. The ordering is part of the decision, not a scheduling detail.

## Consequences

- A newcomer gets two routes in: the repo's own index, and a queryable wiki.
- Agents working on this repository can query the wiki over MCP without a
  credential, for as long as the repo is public.
- This repo now has one public document about itself that its own laws cannot
  hold. That is the price, it is stated here rather than discovered later, and the
  mitigation is that the authority stays in the tree.
- Going private is now a documented trigger for revisiting this record.
