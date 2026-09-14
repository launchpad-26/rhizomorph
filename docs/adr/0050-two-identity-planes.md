# 0050. Two identity planes that never fuse: org membership for humans, `rzk_` keys for machines

- **Status:** accepted, prd-51 ruling 8 as amended 2026-09-08
- **Date:** 2026-09-08

## Context and Problem Statement

The team server has two callers that need to prove who they are, and the two have nothing in
common: a person opening the browser viewer, and an instrument shipping events from a machine that
may never see a human sit at it. prd-51 ruling 8 gave each its own plane rather than one identity
system serving both, and named the property that makes the split worth an ADR: **the planes must
never fuse.** No GitHub token is ever accepted on the ingest route; no key is ever derived from a
GitHub token; the ingest hot path never calls GitHub. That is a structural constraint on every
future route this server grows, not a detail of how sign-in works today, and ruling 8 is the other
constitutional ruling in prd-51 besides the ones that already got ADRs (0033, 0034, 0035).

Ruling 8 was blessed naming an OAuth web flow for the human half. What was built on 2026-09-07 is a
GitHub App instead, and the 2026-09-08 amendment records why — a divergence that would otherwise
sit as a paragraph inside a PRD that dies with prd-51. This record is where it stops being that.

## Considered Options

- **A — Two planes: GitHub organisation membership for humans, `rzk_` ingest keys for machines,
  never convertible into one another.**
- **B — An OAuth App for the human half**, acting as whichever person signs in.
- **C — Repository read permission for the app**, so membership and repository access are checked
  by the same mechanism.

## Decision Outcome

Chosen: **A.**

- **Humans** sign into the team view through a GitHub App, `rhizomorph-team-server`, installed on
  the `rhizomorph-team` organisation. The access boundary is membership of that organisation,
  checked with `read:org` against `GET /orgs/{org}/members/{user}` on an **installation token**, not
  the signed-in person's own — so the boundary does not depend on any individual's grant, and one
  member consenting more widely than another cannot widen it. `204` is a member, anything else is
  not, and **`state: pending` is not a member**: an invitee who never accepted returns `404` by
  construction, so this needs no special-case handling.
- **Machines** hold `rzk_` ingest keys: 32 random bytes, stored only as their SHA-256, shown once at
  mint, scoped to one project, revoked by a row flag checked once per batch — which bounds
  revocation lag to one batch interval. Refusal text names the key prefix and the exact reason.
- **The planes never meet.** No GitHub token is ever accepted on the ingest route; no key is ever
  derived from a GitHub token; the ingest hot path never calls GitHub. A member mints a key in the
  viewer and pastes it once into `rhizomorph connect team` — the two planes touch at that one
  human action and nowhere in the server's code.

**B lost.** An OAuth App acts *as* whichever person authorized it, borrowing their individual
permissions — the access boundary would then be a property of each person's own grant, not of the
organisation, and one member consenting more widely than another would widen the server's reach
without anyone deciding that. A GitHub App is its own identity: installed on an organisation, its
powers chosen from a fixed list at creation and readable by anyone afterwards. **Consequence of
rejecting B:** the org's third-party-access restriction is deleted from scope entirely — it is an
OAuth App concern, since a GitHub App is *installed*, not *approved*, and there is nothing to
approve or check.

**C lost.** Repository read would have handed the server every private repository each member can
reach, in order to answer one yes-or-no question the server actually needs: is this person a
member. The app's permissions are **Organization → Members → Read-only, and nothing else** — no
repository access of any kind, no webhook.

## Consequences

- Good: a compromised ingest key cannot reach anything GitHub-shaped, and a compromised human
  session cannot mint or use an ingest key on its own — the two blast radii don't compose.
- Good: the app reads exactly one fact (organisation membership) with exactly the permission that
  fact requires, so there is nothing to audit beyond that one scope.
- Good: revocation and rotation are independent per plane. Kicking a member out of the org and
  revoking a machine's key are unrelated operations, verified by unrelated checks.
- Bad: a member must still perform one manual, out-of-band act — minting a key in the viewer and
  pasting it into `rhizomorph connect team` — because the planes deliberately don't bridge
  automatically. Device flow for a CLI-side mint is named as future work, not v1.
- Bad: two authorization paths mean two things that can each independently break. A GitHub App
  outage and an ingest-key-store outage are different incidents with different blast radii, and
  on-call has to know which plane an alert is about.
- Neutral: the org boundary is `rhizomorph-team`, rhizomorph's own organisation, not the cohort's
  coursework org — membership of that org is the entire access boundary, exactly as ruling 8 has
  it, independent of which org holds it.
