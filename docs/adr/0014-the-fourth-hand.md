# 0014. The concierge: a fourth hand, granted two powers by explicit invocation

- **Status:** accepted
- **Date:** 2026-08-10

## Context and Problem Statement

> Written at decision time, from prd-20 and the operator rulings of 2026-08-07.
> Not reconstructed — every claim below is either cited or is the decision itself.

Reaching "an instrumented conductor watching my repo" is currently a chain of
shell steps that must run in exactly the right process: clone, build, start,
generate the env block, `eval` it in the shell that will exec the agent,
relaunch the agent. The operator report of 2026-08-07 is a project lead who ran
the instrument and still ended up with an **uninstrumented** conductor. prd-19
made that failure honest; it still hands the user a command line. prd-20
proposes a front door instead: choose a repo, choose a conductor CLI, launch it
instrumented, verify — each an explicit click.

Two of those steps are things no hand of this instrument may currently do.
ADR-0001 grants three: the **observer** reads; the **laboratory** writes refs
under `refs/rhizomorph/` and worktrees it owns; the **recorder** writes session
logs outside the watched repo. The laboratory does start processes — `git`, and
also `workmux` (`lab/fork.ts:277`) and `npm install` (`lab/restore.ts:293`) —
so the line is not "no hand may spawn". It is narrower and sharper than that:
none of them may start a process **the operator names**, with an environment
block, in a directory it chose; and none may write a repo to disk. The concierge
needs both.

The forces in play:

- **The trust claim is public and specific.** `cb4d133` rewrote it to *"state
  the three hands, not one blanket read-only claim"*. The instrument's value is
  that an operator debugging a swarm can tell the observatory's writes from an
  agent's; a fourth power that arrives unannounced makes the published claim
  false, which costs more than the feature is worth.
- **The physics are fixed.** Instrumentation attaches at launch, not
  retroactively (`docs/telemetry.md`). Whatever this hand does about a conductor
  that is already running, it cannot be attachment.
- **This is the largest blast radius yet.** The laboratory spawns `git`,
  `workmux` and `npm` — but each is an executable *it* named, with an argv array
  it built itself, and its law enforces the list. This hand would spawn whatever
  harness the operator names, with an environment block, in a directory it
  chose, and would write a repo to disk from a URL a human typed.
- **The existing enforcement is known to be weak.** ADR-0001's own Consequences
  record it as convention rather than structure, and name the proof: the lab's
  "sole importer" law passed for weeks while `api/lab.ts` crossed the boundary
  through `await import('../cli/index.js')` — a dynamic import a source-text
  grep cannot see, two hops deep (#245).
- **The nearest fence is already breached.** #234 is open: the laboratory is
  reachable from an unauthenticated HTTP route, which is exactly the
  "explicitly invoked by a human" condition its amendment was granted under.

## Considered Options

- **A — A configuration flag.** Let the server launch processes and clone repos
  when a flag or env var is set. No amendment, no new vocabulary.
- **B — A fourth named hand.** Two named powers, each token-gated, each invoked
  only by an explicit human act in the UI, each fenced by its own law test.
- **C — Widen the laboratory's grant.** The lab already spawns child processes
  and already creates directories outside the watched repo; extend its
  namespace to cover launch and clone rather than adding a hand.
- **D — No launch power at all.** Detect and instrument the conductor that is
  already running, so the front door never needs to start anything.
- **E — The hand holds its own credentials.** Give the concierge an OAuth flow
  or a stored token so it can clone on its own authority rather than the
  machine's.

## Decision Outcome

Chosen: **B**, a fourth named hand — the same shape ADR-0001 chose for the
second and third, applied a third time rather than bent.

The grant, in full:

1. **Two powers, named.** The concierge may (a) launch or relaunch a conductor
   process, and (b) clone a repo to disk. Nothing else. A power not on this list
   costs another amendment.
2. **Token-gated.** Every route that exposes either power sits behind the
   capability token of ADR-0008 and ADR-0012. Per prd-20 ruling 2, **no
   concierge route ships before #234's guard covers every mutating route** —
   the fence is fixed before the hand is reachable, not after.
3. **Explicitly invoked.** Each power runs only from a human act in the UI,
   never from a collector, never from a poll, and never on a timer. The hand
   has no clock.
4. **Never inside the watched repo.** Clones land in a directory the concierge
   was handed, which may not overlap the watched repo in either direction, and
   may not be parked inside another hand's namespace under the data root.
5. **It holds no secret.** Clone-by-URL borrows the machine's existing `git`/`gh`
   credentials. "No auth, no cloud, no accounts" stands (operator-decided
   2026-08-07).
6. **It never claims to attach.** It detects an uninstrumented conductor, says
   so plainly, and offers relaunch with continuity, naming what continuity means
   per harness and what is lost (prd-20 ruling 3).
7. **Its own law test**, `server/src/concierge/namespace-law.test.ts`, landing
   before the hand's code — so the fence is never fitted around whatever got
   built.

**A lost** for the reason ADR-0001 rejected the same shape as its Option B: a
flag makes mutation a configuration detail, so nothing structural stops the
next feature adding another. The argument does not get weaker when the mutation
is `spawn` instead of `write`; it gets stronger. prd12's clause — *"the
read-only constitution is AMENDED, not dissolved"* — is what a flag dissolves.

**C lost** as the most tempting option, and the one worth recording carefully.
Reusing the laboratory would have cost no amendment and no new directory, and
the lab genuinely does spawn processes already. It loses on two counts. The
lab's grant is specific — refs under `refs/rhizomorph/`, worktrees it owns, and
`git` verbs chosen from a list its law enforces — and "may start the operator's
agent CLI with an env block" is not a widening of that grant but a different
grant sharing a directory. Worse, it would make one module the subject of two
fences with different shapes, and the module already at issue in #245 is the
lab: the honest move when a fence is known to leak is not to hang more weight
on it. A second reason is legibility — the public trust claim enumerates hands,
so a fourth power hidden inside the second hand's name is precisely the
Email-Driven Architecture failure `docs/adr/README.md` exists to prevent.

**D lost to physics, and it is worth being explicit that it lost to evidence
rather than to preference.** `docs/telemetry.md` records that instrumentation
attaches at launch; the `.workmux.yaml` SCAR is the same requirement failing
invisibly once already, proven only by reading `/proc/<pid>/environ`. A
front door that silently "attached" to a running conductor would be a lie the
instrument told about itself, which is the one failure this codebase treats as
unrecoverable. Relaunch with continuity (`claude --continue`) is the reachable
version of the same wish, and it is honest because it names what it costs.

**E lost** on the non-goal it would breach, and it is a real fork rather than a
strawman: a stored token is the obvious way to clone a private repo, and
clone-by-URL is half of power (b). It loses because a hand that holds a
credential has something worth stealing, and this instrument's security posture
is built on having nowhere to put one — localhost-only, single-origin,
no accounts (ADR-0008; prd-23 makes the same property load-bearing). Borrowing
the machine's own `git`/`gh` credentials clones exactly the repos the operator
could already clone from that shell, and no more.

**On the record itself.** This ADR *is* the third amendment to ADR-0001, and it
is the first one that exists as a file. ADR-0001's Status line has until now
promised two records, `ADR-0001a` and `ADR-0001b`, that were never written — the
laboratory and recorder amendments live as items 2 and 3 of ADR-0001's own
Decision Outcome list, each with its commit. The convention this record asserts,
and which `docs/adr/README.md` now states, is that **an amendment is a new
top-level ADR**: the log has one numbering scheme, sub-numbers were never part
of it, and an amendment is exactly the kind of decision — structural,
constraining, expensive to reverse — the log is for. ADR-0001's dangling
reference is repaired as a broken link, not rewritten; its reasoning is
untouched.

## Consequences

**Good.** The public claim stays checkable: four hands, each named, each with
its own enforcing test. The amendment lands before the code, so wave 2 inherits
a fence rather than negotiating one. And prd-20 ruling 2 now has a structural
partner — the declared-importer set in the concierge's law is empty, so the
first route to reach this hand fails a test until someone reads the ruling.

**Good, and decided here because later waves copy it: a declared importer bounds
a route, it does not exempt a file.** Review of this PR found the first draft
exempting the *node*, which would have admitted the one legitimate route and
then convicted everything above it — `api/index.ts`, `build-app.ts`, the CLI and
every `buildApp` test — so the wave that declared a route would have had to
allowlist its whole ancestor cone or weaken the sweep. A declared importer is
therefore a **terminus**: chains stop there, and what lies above inherits its
grant. What that deliberately does not relax is grant 3 above. The collectors
and the poll loop are judged against the *raw* graph, unbounded, because for
them any route into this hand is a violation — a token gate does not make a poll
a human.

**Bad — this law is stricter than its predecessors, and still not structure.**
It replaces the per-file grep with reachability over the whole import graph of
both packages, reads backtick specifiers, canonicalizes paths through
`realpath(3)`, and refuses to be blind: a dynamic `import()` with a non-literal
specifier is itself a violation, because an edge the graph cannot follow would
let the check pass while knowing nothing. That closes #245's two holes — and a
third that review of this PR found: **escape sequences**. A specifier may spell
any of its letters as an escape, and `import { x } from '../concier\u0067e/paths.js'`
is a plain string literal: the blind-spot clause has nothing to object to, and
its *raw* text names no file, so the reachability clause saw a clean tree —
while Node decoded it to `../concierge/paths.js` and loaded the hand. Specifiers
are therefore decoded before they are resolved. That spelling is cheaper than
any of the three below, and until review it sat unnamed beside them.

It still does not close `eval`, a native addon, a specifier assembled from a
network response, or a shell that reaches the hand from outside the process. A
law over source text is still a law over source text — and the escape hole is
the evidence for that sentence rather than a footnote to it: the list of
spellings a text law cannot see is only ever as long as the last person to look.

**Bad — the strictness has a cost other lanes will pay.** "No non-literal
dynamic `import()` anywhere in server source" is a constraint on files this hand
does not own. It holds today (the one dynamic import in the tree is a literal),
and a future lane that needs a computed specifier must widen clause 2's own
exemption and argue for it in review — there is no declared-exception
mechanism today, so the set such a lane would name starts, and may stay,
empty. (This sentence used to promise a mechanism the law never got — found in
review of #351's re-review, #374 — the same shape `ALLOWED_IMPORTERS` gives
clause 1, but clause 2 has no analogue of it, and the fix here is naming that
rather than building one nobody has needed yet.) That friction is intended,
and it is friction.

**Bad — the fourth hand is the one whose command the operator wrote.** A mistake
in the lab runs a command the lab itself chose from a fixed list; a mistake here
runs the one a human typed into a form. The law's fourth clause
forbids the module from reaching a shell at all — `exec`/`execSync` are out
however they are imported, and the only permitted `shell:` value is a literal
`false` — which removes the injection path a repo URL or branch name would
otherwise take, but does not remove the fact that this hand's purpose is to run
something.

That clause is written the way it is because review of this PR ran seven
ordinary spellings of a shell call past its first draft and all seven passed:
the draft required a `node:` prefix on the module, and required the import and
the call to share a line. A detector that only catches the spellings its author
happened to write is the same defect as #245 wearing different clothes, so the
clause now binds the imported name and reads the whole file, and each of the
seven is a permanent fixture in the law. The re-review found two more ordinary
spellings the identifier-binding still missed — an inline
`require('child_process').exec(…)` that binds no name at all, and a
`const cp = await import('node:child_process')` binding, which clause 2 has
nothing to say about because the specifier is a plain literal (#373) — both
now permanent fixtures too.

**Bad — and one route to a shell the clause admits on purpose, because it
cannot tell it apart from the launch power's own need.** `execFile('/bin/sh',
['-c', cmd])` and `spawn('bash', ['-lc', cmd])` are argv-array calls, exactly
the shape clause 4 must permit so the launch power has something to spawn —
and both reach a shell anyway (#373). The clause's stated promise, "nothing
under `concierge/` reaches a shell," is therefore not fully true of the text
it enforces: the gap is *which executable* is named, not *how* it is
invoked, and which-executable is an allowlist question, not a spelling one,
so this is not a hole the clause's regexes can close without banning the argv
forms the hand needs. #358's harness registry is the mechanism that closes it
— once the executable a real launch spawns comes from the adapter rather than
from a request, the promise becomes true by construction. Named here, and in
the law's own module comment, rather than left implied.

**Neutral — one open question stays open.** prd-20 does not rule where cloned
repos live. The fence is therefore expressed relative to a clone root its caller
supplies, not a hard-coded default, so answering the question later sets an
argument rather than reopening this law. The fence does assume **one** watched
repo (prd-20's "no simultaneous multi-repo" non-goal); simultaneous multi-repo
would multiply fence roots and is a different decision.

**Neutral.** A fifth power still costs a public argument and a fifth ADR, which
is the intended friction.
