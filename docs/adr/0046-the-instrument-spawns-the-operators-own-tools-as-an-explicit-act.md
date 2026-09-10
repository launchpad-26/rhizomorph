# 0046. The instrument spawns the operator's own tools as an explicit act, and never holds a credential

- **Status:** accepted (prd-55 ruling 1; recorded on the build, #412)
- **Date:** 2026-09-10

## Context and Problem Statement

Until prd-55 the instrument spawned exactly two kinds of subprocess, and both
were plumbing: read-only queries whose output it folds (`git`, `tmux`,
`workmux`), and one launcher it hands a lane to (`workmux add`, in
`packages/server/src/lab/fork.ts`). None of them is a paid service. None of
them authenticates as anybody. The trust document could therefore say, without
qualification, that this thing reads your machine's own record and sends
nothing anywhere.

prd-55 ruling 1 asks for something categorically different: the laboratory's
R&D hand is **the operator's own `claude`**, spawned in print mode with a
corpus in its prompt, and what comes back is validated and recorded. That
subprocess talks to a paid API over the network, under somebody's login, and
bills somebody's account.

Three questions had to be answered before a line of it was written, because
answering them afterwards is how an instrument that promised to be a witness
becomes a participant nobody agreed to:

1. May this instrument spawn a tool that costs money and reaches the network at
   all?
2. If it may, whose credential is used, and where does it live?
3. Whose egress is it, and where is that said?

## Considered Options

- **Spawn the operator's own already-authenticated CLI, on an explicit act.**
- **Call the model API directly** from the server, with a key the instrument
  reads from configuration or the environment.
- **Refuse entirely** — the instrument observes and never originates a paid
  call, and R&D stays a thing the operator does by hand in another terminal.
- **Spawn the CLI, but from a background loop** so patterns are proposed
  without anyone asking.

## Decision Outcome

**The instrument may spawn the operator's own tools as an explicit act; it
never holds or forwards a credential; a spawned tool's egress is the
operator's, declared on the control that invokes it.**

That sentence is ruling 1's, and it is the decision. Its three clauses are
three separate constraints, each with a mechanism:

**An explicit act.** The R&D hand runs only from `rhizomorph lab rd` or from
the route a person's click reaches — prd-12 ruling 1's second hand, unchanged.
`packages/server/src/lab/rd.ts` has no clock: no `setInterval`, no `setTimeout`,
nothing that could fire on its own, and `packages/server/src/lab/rd.test.ts`
asserts that structurally rather than by convention. The laboratory's namespace
law already forbids every observer module from importing anything under
`packages/server/src/lab/`, so there is no collector, no poll and no background
loop with a path to it.

**Never a credential.** The instrument stores no key, reads no key, forwards no
key and logs no key. It does not need one: the operator's CLI is *already*
authenticated, by the operator, before this instrument ever ran. The engine
passes no environment of its own to the child — it never sets `Exec`'s `env`
option, so the child inherits the server's environment unchanged and this
instrument adds nothing to it. The binary is resolved on the server's PATH
under a name the operator declares in
`packages/web/src/settings/registry.ts` (`lab.agentCommand`), which is a NAME
and not a secret, and never from an environment variable — a claim
`rd.test.ts`'s own grep holds to exactly two environment names across
everything `packages/server/src` ships, beside a second grep that finds no
credential-shaped literal in any of it.

**The egress is the operator's, declared where it is invoked.** The subprocess
reaches the network under the operator's own login and bills their own account;
this instrument is the thing that asked, not the thing that paid. So the ask is
made where the cost is visible: the CLI subcommand and the route both name what
they are about to spend on, and every event the run records carries the CLI's
OWN reported figures as provenance — `total_cost_usd`, `duration_ms`, the model,
the prompt digest, the corpus digest, and `claude --version` — copied from its
result rather than re-derived here.

*Calling the API directly* lost on question 2 and would have lost on 3. A key
in configuration or in the environment is a key this instrument holds, which
ends the unqualified claim in the trust document and replaces it with a
paragraph about how carefully the key is handled. It also moves the billing
relationship: an API call from this server is the instrument's egress by any
reading, and no wording makes it the operator's.

*Refusing entirely* was the honest default and is why this record exists at all
rather than a comment. It lost to a narrow case with a real answer: the
operator already runs this exact CLI, already pays for it, and the thing they
want is for the instrument to hand it the record the instrument already holds.
Refusing would not have protected them from an egress — it would have made them
copy the corpus into another terminal by hand.

*A background loop* lost outright and is not a close call. It is the thing
prd-12 ruling 1 exists to forbid, and money makes it worse rather than
different: a proposal nobody asked for is a bill nobody watched.

## Consequences

- Good: the trust document's strongest claim survives intact. This instrument
  still holds no credential, and that is now a checked property of
  `packages/server/src` rather than a sentence about intent.
- Good: the cost is legible where it happened. The figures on every rd.* event
  are the CLI's own, so the provenance a surface prints and the record a
  reviewer reads cannot disagree — neither is derived from the other.
- Good: this generalises without widening. Any future tool the operator already
  owns can be spawned under the same three clauses, and a tool that would need
  the instrument to authenticate is refused by the second one before anyone
  argues about the first.
- Bad: the operator's own CLI is now on this instrument's critical path for one
  surface, and the instrument cannot fix a broken one. It can only say so —
  which it does, in one fixed sentence when the binary is not on the server's
  PATH, and with the binary's own words when it is there and fails.
- Bad: "the egress is the operator's" is a statement about billing and
  authentication, not about data. What the corpus contains still leaves this
  machine, inside the prompt, and the operator is the only control on that.
  Today the corpus is the repo's own retros, reviews and measured verdicts —
  its shape is bounded by what the engine reads and nothing is included that
  the record does not already hold — but that is a property of this code, not a
  guarantee this record establishes.
- Bad: a spawned tool's own behaviour is outside every law here. The engine
  grants it no tools and no MCP servers on the command line, and records the
  exact argv it used in its own doc comment, but a CLI that ignored those flags
  would be doing something this instrument cannot detect from outside the
  process. The claim is about what is asked for, and it is stated at that size.
- Neutral: the same clauses would permit spawning the operator's `gh`, which
  prd-55 ruling 2 goes on to do for the tracker corpus. That is the decision
  working as intended and not an extension of it: `gh` is the operator's, is
  already authenticated, and is invoked only when they declare it.
