# 0034. The fifth hand: the shipper has a clock and holds one key, bounded — amends ADR-0001 and ADR-0019

- **Status:** accepted (prd-51 blessed 2026-09-03)
- **Date:** 2026-09-03
- **Amends:** ADR-0001 (the grant list at `0001:35-43` gains a fifth entry) and ADR-0019 (grant 3,
  *"the hand has no clock"*, and grant 5, *"it holds no secret"*, are true of the concierge and
  are **not** the law for every hand). ADR-0019's option E stays rejected *for the concierge*; this
  record reopens it for a different hand, on the merits, and states the bound.

## Context and Problem Statement

ADR-0001 made the instrument read-only over the watched repo and ruled that further powers are
granted as named hands, *"each explicitly invoked by a human and each fenced by its own test"*,
and that a flag is the wrong shape because *"a flag makes mutation a configuration detail, so
nothing structural stops the next feature adding another."* Four hands exist: the observer reads;
the laboratory writes refs under `refs/rhizomorph/`; the recorder writes session logs outside the
repo; the concierge launches a conductor and clones a repo. ADR-0019 bounded the fourth with five
grants, two of which every later reader has quoted as if they were constitutional for all hands:
*"The hand has no clock"* and *"It holds no secret."* Its option E — a hand holding a stored token
— lost because *"a hand that holds a credential has something worth stealing, and this
instrument's security posture is built on having nowhere to put one."*

prd-51 builds a shipper: a process that tails the member's ledger on a batch timer and posts it to
a team server under an ingest key. It has a clock and it holds a secret. Under ADR-0019 as
written it is forbidden twice over, and the friction ADR-0019 named — *"a fifth power still costs
a public argument and a fifth ADR"* — is exactly what this record pays.

## Considered Options

- **A — Do not build it.** The team view stays impossible (ADR-0033 context).
- **B — Build it as a mode of an existing hand**, e.g. the recorder also ships, or the local
  server gains a `--team` flag. No new ADR, no new law test.
- **C — Build it in the team server's trust domain instead**: the server pulls from each member's
  machine. Every instrument opens an inbound port.
- **D — A fifth hand, argued in public, with the clock and the key each bounded by a law test
  that reads the import graph**, the way ADR-0019's namespace law bounds the concierge.
- **E (0019's E, revisited) — A hand that holds a credential**, which is what D is. The question
  is not whether but under what bound.

## Decision Outcome

Chosen: **D**. The shipper is the **fifth hand**, and ADR-0001's list gains:

> 5. **The shipper** (prd-51) — reads the session ledger and posts it, re-serialized, to one
>    team server; runs on a batch timer once enabled; holds one project-scoped ingest key.
>    Enabled only by `rhizomorph connect team`, an explicit CLI act per repo. Never from a
>    collector, a poll or a boot. Opens no listening socket.

The bound, each clause a law test (`hand-law.test.ts`, beside the shipper's source under
`packages/server/src/`), which lands before the shipper's first source file:

1. **Outbound only.** Nothing under `shipper/` imports a listener; the instrument's bind
   (`cli/run.ts`) and `mutation-guard`'s loopback set are read by the test and widened by nothing.
2. **One credential, one shape, one place.** A single `rzk_` key, project-scoped, revocable
   server-side, stored `0600` under the data root. It is on none of prd-38 ruling 4's never-list:
   never the server process's logs, never the SPA, never a plain-JSON prefs file, never argv, never
   a child's env, never the hash-chained record, never a log line. `doctor` reports presence, never
   value.
3. **The clock is bounded to one act.** The timer exists only after `connect team` has run for this
   repo; the import graph from every collector and from the poll loop to the enable path is empty,
   judged raw and unbounded the way ADR-0019 judges grant 3 — a token gate does not make a poll a
   human.
4. **It sends only what a record carries** (ADR-0033). The re-serialization is the veil's mechanism
   and the test plants a removed field and watches it fail to cross.
5. **Enabled is visible.** `/connect` shows the `team server` row for as long as the hand is
   enabled: VERIFIED only on an acknowledged batch, BROKEN with the exact remedy, UNPROVEN
   otherwise. Being shipped is never silent.

**Why E is acceptable here and was not for the concierge.** The concierge's credential would have
been a *forge token* — read and write over every repo the person can reach, worth stealing by
anyone. The shipper's key is a *write-only ingest token for one project's telemetry*, minted by the
team, revoked by a row flag the server checks every batch, and useless for reading anything: a
stolen key can append lines to one project's noticeboard until the next batch after revocation.
That is a bounded loss, and the bound is the argument. What made "nowhere to put a credential"
valuable was that the local instrument had nothing worth taking off it; the shipper does not
change that, because the key is the only thing added and it opens nothing on the member's machine.

**B was rejected** because it is the flag ADR-0001 refuses: a recorder that sometimes ships is a
recorder whose Trust section is conditionally true. **C was rejected** because an inbound port on
every member's machine is the one property the whole design is built to avoid; the local
instrument stays loopback-only and the shipper is an HTTPS client.

## Consequences

**Good.** The constitution stays a list of named hands with named bounds. A sixth power still
costs a public argument and a sixth ADR.

**Good.** ADR-0019's grants 3 and 5 are now correctly scoped: they bound the concierge, and any
hand that wants a clock or a key must say so in its own record, as this one does.

**Bad.** The README Trust section's sentence *"What it sends, and to whom: nothing, ever, off this
machine"* becomes false when the hand is enabled. prd-51 ruling 12 binds the rewrite to the
shipper's own commit. The Langfuse-forwarder gate (`docs/roadmap.md`) closes in the same edit,
because this is the re-ruling of the Trust section it was gated on.

**Bad.** There is a credential on disk. Its bound is stated above and tested; a future reader who
finds a second credential path under `shipper/` has found a violation of this record, not an
extension of it.

**Neutral.** The shipper does not change what the recorder writes, when a recording ends, or what
the laboratory may touch. The four existing hands are unchanged.
