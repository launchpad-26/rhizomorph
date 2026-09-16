# 0055. The beacon door is per installation, and the anti-fold guarantee becomes a routing rule with a law — amends ADR-0036

- **Status:** proposed (prd-57 ruling 6)
- **Date:** 2026-09-15
- **Amends:** [ADR-0036](0036-a-beacon-is-a-line-in-a-watched-directory.md). Its door moves from one
  directory per watched repo to one directory per installation. **Its guarantee does not move** —
  a beacon from one repo's swarm must never fold into another repo's session — only the mechanism
  that enforces it.

## Context and Problem Statement

ADR-0036 put the beacon door at a path keyed by the repo's slug, and chose that over an
instrument-wide door for a stated reason: *"the pi collector learned that scoping the hard way … and
had to enforce it by header; a directory keyed by the repo's slug enforces it structurally."*

That reason is correct and this record has to answer it rather than walk past it. The scoping
failure behind it was real: a session-file collector attributed sessions by where their files sat on
disk, and one codebase's work turned up inside another's lanes. Anything that gives up a structural
guarantee for a procedural one owes an account of why the procedure will hold.

**What has changed is who writes the line.** ADR-0036 was written when every beacon writer was a
rhizomorph process or a swarm script that already knew which repo it was in. A harness lifecycle
hook is not: it fires in whatever directory the agent happens to be working in, for a repo the
instrument may never have heard of, and it is invoked by the harness rather than by the instrument.

That makes the per-repo door unbuildable as specified, for two independent reasons:

1. **The writer would have to know the reader's slug derivation.** The slug is *"a sanitized repo
   basename plus a short hash of its absolute path"*. A hook runner computing it independently is a
   second implementation of a hash that must agree forever with the first, and the day they disagree
   is the day beacons land in a directory nothing tails — silently.
2. **A hook fires for repos that are not watched.** Under a per-repo door the runner must either
   create a directory for a repo the instrument has not discovered, or drop the line. The first
   makes the runner a discovery mechanism; the second loses declarations the instrument will want
   the moment that repo *is* watched.

## Considered Options

- **A — One door per installation, with routing by `cwd` at the collector**, and a law that proves
  two repos' lines in one door do not fold into each other.
- **B — Keep the per-repo door**, and have the hook runner resolve the repo and compute the slug.
- **C — A door per harness session**, keyed by the session id the hook already carries.
- **D — A route instead of a door** — the hook POSTs to the running instrument.

## Decision Outcome

Chosen: **A**. The door is one directory under the installation's own data root. Every line carries
the `cwd` the hook reported. The collector routes each line to a session by containment against the
worktrees it watches; a line matching no watched repo is **retained and attributed to none**, so it
is available unchanged if that repo is later watched.

**The guarantee is preserved as a law, not as a hope.** A test plants two repos' lines in one door
and asserts that neither folds into the other's session — the failure ADR-0036 named, asserted
directly rather than inferred from a directory shape.

**This is the mechanism the pi collector already proved, in this tree.** Faced with exactly ADR-0036's
problem, `packages/server/src/collectors/pi/collector.ts` chose routing over directory shape: it
*"does not assume a slug convention it cannot back"*, walks its root recursively, and identifies
*"each session by the `cwd` its own header line reports … never by where the file happens to sit on
disk"*, dropping any session it cannot attribute. Its own comment draws the distinction this record
turns on — that structural scoping is what a worktree-derived collector *"gets structurally"*, while
*"pi has to apply it explicitly"*. It has done so since `a51b0867`. So ADR-0036's cautionary example
is, in its present form, a working implementation of the rule proposed here.

**B lost** on the two reasons above, and the first is the serious one: a duplicated slug hash is a
silent failure mode, and silent is the property this repo's laws exist to remove. It also fails the
undiscovered-repo case with no good answer.

**C lost** because a session id is not a scope. Routing by it would put the join key in the path and
still leave the collector asking which repo a session belongs to — the same question, one directory
deeper, with a directory per session to garbage-collect.

**D lost** for the reason ADR-0036 rejected it: a route is a privileged surface on a localhost
server, it requires the instrument to be running at the moment a hook fires, and a hook that must
reach a socket is a hook that can block an agent. The door works when nothing is listening, which is
the whole point of a door.

## Consequences

**Good.** The hook runner is trivial and cannot be wrong about scope. It appends what it was given
and knows nothing about repos, slugs or which instrument will read it — so there is no derivation to
keep in agreement with anything.

**Good.** Declarations from a not-yet-watched repo survive. Under the per-repo door they had
nowhere to go; here they sit in the door until that repo is watched, which is what prd-58's
discovery needs.

**Good.** The anti-fold property becomes a test that can fail. A directory shape enforces a rule
without ever demonstrating it; a planted-lines law demonstrates it on every run.

**Bad.** The guarantee is now procedural. If the routing rule is wrong, lines cross — which is the
exact failure ADR-0036 chose the directory to make impossible. The law is the mitigation and it is
not a complete one: it proves the rule holds for the case it plants, not for every case.

**Bad.** One door is a shared file surface across every repo on the machine. A writer that misbehaves
affects all of them rather than one, and the door's growth is no longer bounded per repo.

**Bad.** The runner creates the directory, which ADR-0036 assigns to the writer — *"the writer that
appends is the one that knows the directory has to exist"* — but the writer is now a rhizomorph
subcommand invoked by the harness rather than by a hand. It writes only into its own installation's
data root and only ever appends, and it is installed by the enlist grant of
[ADR-0053](0053-the-fourth-hand-may-enlist-a-harness.md); a reader who finds it writing anywhere else
has found a violation of this record, not an extension of it.

**Neutral.** ADR-0036's line shape, its digest, its malformed-line handling and its
sidecar-for-content / event-for-occurrence split are all unchanged. `packages/core/src/events/beacon.ts`
keeps its closed field set and its strip-on-parse behaviour; this record moves a directory and adds
a rule, and changes nothing about what a beacon *is*.
