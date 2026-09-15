# prd-50 — the fixed ceiling: a refusal an operator may not soften

> **Outcome:** shipped 2026-09-08. Blessed by Ciaran Slow, 2026-09-02, in session; rulings 1-3
> accepted as written. Milestone `prd50`. Drafted the same day against `main` at `07a8f9d`, from prd-41's orphaned
> residual *"whether the lock ceiling is configurable"*. That residual named prd-35's settings
> surface as its owner; prd-35 is shipped, and the surface it built cannot hold this. Successor to
> neither prd-41 nor prd-35 — it takes one question both left, and cites their rulings rather than
> restating them.

## Problem

prd-41 closed with a residual reading *"Whether the lock ceiling is configurable. prd-35's
settings surface. **Owned by a PRD, not by an issue.**"* Both halves of that are wrong, and the
second is the interesting one.

prd-35 is shipped, so it can take no new waves. But the deeper reason the residual never moved is
that **prd-35's surface structurally cannot hold this value**. That surface is a browser registry
over `localStorage` and `sessionStorage`, in three client-side scopes. `LAB_CLI_LOCK_CEILING_MS`
is a server constant, and the server has nowhere for a persisted preference to land: no config
file, no settings store of its own. Its runtime inputs are two environment variables and
per-invocation CLI flags, and none of them reaches a ceiling. The residual was not one wave from
done; it was pointed at a place with no room for it.

The cost is a promise the instrument cannot keep. The design note governing these numbers invites
tuning — *"raise it if a real workflow needs more"* — and no operator can raise anything without
editing source and rebuilding. prd-41's own first residual is an operator hitting a 5 s ceiling on
a cold npm cache with no recourse. Meanwhile prd-35 built the machinery for deciding exactly this
— a named list of what may never be configured, with a law behind it — and this number was never
run through it. It sits on neither side of the line, which is the one state that reads as an
oversight rather than a decision.

## Evidence

- **The residual's stated owner is shipped.** prd-41's residuals section names prd-35's settings
  surface; `docs/prds/done/prd-35-the-operators-hand.md`'s Outcome line reads `shipped`. Corrected
  in `5cbf4be`.
- **That surface is client-side, all of it.** `packages/web/src/settings/registry.ts`'s own doc:
  *"`machine` and `repo` are `localStorage`; `session` is `sessionStorage`"* — three scopes, three
  browser stores, no server leg.
- **The server has no configuration store.** `process.env` across `packages/server/src`,
  excluding tests, yields exactly `PORT` and `OUT_DIR`, and nothing reads a config file. CLI flags
  are real operator input — `runCli` dispatches on `argv` — but they are arguments to one
  invocation, not a persisted preference, and no flag reaches a ceiling.
- **The ceiling's only override is a test seam, and says so.** `packages/server/src/api/lab.ts`
  exports `LAB_CLI_LOCK_CEILING_MS = 30_000`; `withLabCliLock`'s `ceilingMs` parameter is
  documented *"a test seam; production takes the default."*
- **The design note invites an action with no mechanism.** `docs/design-notes/lab-launch-ceilings.md`
  on `MAX_ARMS`: *"Raise it if a real workflow needs more."* There is no way to raise it.
- **prd-35 already built the decision procedure, and skipped this.**
  `packages/web/src/settings/non-negotiables.ts` holds `NON_NEGOTIABLES` — ruling 2's five entries
  as executable law. The lock ceiling appears in neither that list nor `PREFERENCES`.
- **The guard cannot currently express a server value.** Each `NON_NEGOTIABLES` entry matches a
  **rendered control's** id, label and options against a regex. It answers "no browser toggle
  weakens this", which is not the claim a server constant needs.
- **Raising this particular ceiling would buy back a refused behaviour.** The design note is
  explicit that the ceiling *"is about attention and spend, not concurrency"*, and prd-12 ruling 3
  already holds that a queue hides spend behind latency. An operator who set it to five minutes
  would have rebuilt the queue prd-41 ruling 2 refused.

## Success

1. **The ceiling sits on a named side of prd-35's line, citably.** Not met while prd-41's
   residuals list carries it as ownerless, or while it appears in neither `NON_NEGOTIABLES` nor
   `PREFERENCES`.
2. **A law fails on the change that would soften it.** Not met while a configuration input could
   be wired to `LAB_CLI_LOCK_CEILING_MS` with the suite staying green.
3. **The design notes stop inviting what cannot be done.** Not met while
   `lab-launch-ceilings.md` says "raise it" without naming the mechanism or the refusal.
4. **The verdict is reachable from the code it governs.** Not met while `api/lab.ts` cites no
   ruling for why its ceiling is fixed.

## Non-goals

- **Not a server settings surface.** Whether the server should ever accept operator configuration
  is a real question and a large one; this PRD answers it for **one** value and does not build the
  general mechanism. A later PRD may; nothing here forecloses it.
- **Not prd-41's other two residuals.** `FORK_EXEC_TIMEOUT_MS`'s number and the `install: false`
  default flip are rulings about *what a value should be*. This is a ruling about *who may move
  it*. They stay separate and stay open.
- **Not prd-35's registry, its scopes, or its browser stores.** No wave touches `PREFERENCES` or
  the settings page.
- **Not the other ceilings.** `MAX_ARMS`, `RESTORE_EXEC_TIMEOUT_MS`, `COMPARE_*` and the collector
  and route budgets are the same family and are deliberately out of scope — see Open questions.
- **Not a re-litigation of prd-41 ruling 2.** That the lock refuses rather than queues is settled;
  this asks only whether the refusal's threshold is the operator's to set.

**Rejected alternatives.** *Make it configurable with a documented ceiling on the ceiling* — a
bound on a bound, and the operator who wants five minutes is precisely the one for whom the cap
becomes the next complaint; it also concedes the principle while keeping the complexity. *An env
var, quietly* — this is how the two existing ones arrived, and an undocumented env var is a
configuration surface nobody audits and no law guards; prd-35 ruling 4's "a changed setting looks
changed" would be false by construction. *Leave it as a residual and let the next person decide* —
tried, for the length of prd-35's whole lifetime, which is the evidence above.

## What already exists (do not rebuild)

- `LAB_CLI_LOCK_CEILING_MS`, `withLabCliLock`, `LabCliLockCeilingError` and its 503 mapping, all
  in `packages/server/src/api/lab.ts`, with the refusal's diagnostic already naming what it waited
  on.
- `NON_NEGOTIABLES` and `non-negotiables-law.test.ts` — the list, its reasons, and its enforcement
  posture. The file already states that a sixth entry *"is a change to the instrument's claim
  about itself"* and lands in a reviewed diff, so the shape for adding one exists.
- `docs/design-notes/lab-launch-ceilings.md` — the numbers and their reasoning, cited from code.
- prd-12 ruling 3 (money is never hidden), prd-41 ruling 2 (refuse, never queue), prd-35 rulings 2
  and 4 (the non-negotiables; a changed setting looks changed). All cited, none restated.

## Rulings

## Ruling 1 — the lock ceiling is not the operator's to raise, and that is a claim, not an omission

`LAB_CLI_LOCK_CEILING_MS` stays fixed in source. The reason is not conservatism about
configuration: the ceiling is the mechanism by which a launch that would wait silently behind
another one refuses instead, and prd-12 ruling 3 forbids exactly the trade an operator would make
by raising it — spend hidden behind latency. A configurable threshold here is a supported way to
rebuild the queue prd-41 ruling 2 refused, arriving, as `non-negotiables.ts` puts it, *"wearing a
reasonable face."*

Lowering it is harmless and equally unnecessary; a single fixed value is the honest form. It
extends to this constant only — not to the family, and not to the server's configurability in
general.

## Ruling 2 — it joins prd-35's non-negotiables as a sixth entry, with a guard that fits a server value

The list gains its sixth entry, with its reason beside it, in the reviewed diff its own doc
prescribes. Because the existing guard reads rendered browser controls and this is a server
constant, the entry carries a guard of the shape the claim actually needs: **the ceiling is read
from exactly one place, and no configuration input reaches it.** A future env var, config file
key, request field or preference wired to that constant fails the law by construction, rather than
depending on a reviewer noticing.

## Ruling 3 — the design notes stop inviting what cannot be done

`lab-launch-ceilings.md`'s tuning invitations are corrected to say which numbers are fixed and
why, citing this PRD. An invitation to raise a number that cannot be raised is the same defect
class prd-43 exists for — prose making a claim nothing checks — and it is what turned this
residual into a year of drift rather than a decision.

## Sequencing (waves, each gated as ever)

`packages/web/src/settings/` is prd-35's built territory and this PRD enters it **only** to add
`non-negotiables.ts`'s sixth entry; `PREFERENCES`, the settings page and the scopes are untouched.
`packages/server/src/lab/` is prd-41's and is not entered at all — this PRD's server change is in
`api/lab.ts`, beside the constant. `docs/prds/**` is the PRD corpus's own; no wave here edits a
PRD, including prd-41's residual line, which is operator paper.

**Wave 0 — operator act, discharged 2026-09-02.** The three rulings were blessed as written, in
session. It was never dispatchable: ruling 1 decides what the instrument claims about itself, and
a lane cannot make that call. Recorded rather than deleted, because the condition it carried still
binds — had ruling 1 been rejected in favour of configurability, this PRD would have been
superseded rather than amended, since every wave below assumes the fixed verdict and nothing
else.

**Wave 1 — the Keystone.** `prd50 w1: no configuration input reaches the lab lock ceiling`
(ruling 2's guard). Additive, zero-claimant: a law over `api/lab.ts`'s single read of the constant,
landing green, plus the sixth `NON_NEGOTIABLES` entry and its reason. Everything downstream cites
it.

**Wave 2 — parallel, fenced apart:** `prd50 w2: api/lab.ts says why its ceiling is fixed`
(the doc comment beside `LAB_CLI_LOCK_CEILING_MS` cites ruling 1, discharging success 4) ·
`prd50 w2: the launch-ceilings note says which numbers are fixed` (`lab-launch-ceilings.md`,
ruling 3).

**Unfiled work implied, described not numbered:** prd-41's residual line still reads as ownerless
and wants a pointer here once this is blessed — a paper edit to a shipped PRD's closeout, which is
the operator's act and not a wave. The two remaining prd-41 residuals stay where they are.

## Open questions

- **Whether the rest of the ceiling family follows this verdict.** `MAX_ARMS`,
  `RESTORE_EXEC_TIMEOUT_MS`, `COMPARE_VERIFY_TIMEOUT_MS`, `FORK_EXEC_TIMEOUT_MS`,
  `ROUTE_EXEC_TIMEOUT_MS` and `COLLECTOR_EXEC_TIMEOUT_MS` are the same shape, and `MAX_ARMS` is the
  one carrying the "raise it" invitation ruling 3 corrects. The argument for ruling 1 is specific
  to *this* ceiling — spend hidden behind latency — and does not obviously transfer to a ceiling
  that bounds a hung subprocess. Deliberately not generalised. **Open, not ruled.**
- **Whether the server should ever take operator configuration.** Two env vars is not a policy, it
  is an absence. This PRD answers one value and declines to answer the class. **Open, not ruled.**
- **Whether `non-negotiables.ts` is the right home for a server claim.** It lives in
  `packages/web/`, and a sixth entry about a server constant makes it a cross-package register.
  The alternative is a second list beside the server code, at the cost of splitting the answer to
  "what may never be configured" across two files. Ruling 2 takes the single-register option
  deliberately; if wave 1 finds the import direction ugly, this is the thing to revisit. **Open,
  not ruled.**
