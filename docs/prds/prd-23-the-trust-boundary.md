# prd-23 — the trust boundary: the guard holds at both ends

> **Status:** proposed · prd-20 ruling 2's gate is this document's subject

## Problem

rhizomorph promises no auth, no cloud, no accounts, and a loopback-only socket. The office-network
stranger it defeats. **Any local process running as the same user** can `curl` the route that forks a
worktree and launches an agent, and today it succeeds — not hypothetical here, where what is watched
is a swarm of agents with shell access. **A page in another tab** cannot mutate anything, but every
read is exempt from the guard: a page that rebinds its hostname to `127.0.0.1` counts as same-origin
and reads agent transcripts and the live stream. And the one control that exists points the wrong
way: the only route carrying the capability token is the one route the dashboard needs, and the
browser cannot obtain it, so a shipped, documented button fails on every boot — while the docs
describe the fence as whole and the operator can verify none of it.

## Evidence

- **Live boot** (#249; audit PR #280): untokened, `POST /api/label` → **401**, `POST /api/rotate` →
  **200** *and it rotated the session*, `POST /api/lab/launch` → **400** at body validation. The
  token, minted in memory at `server/build-app.ts:67`, never leaves it: `grep -ri capability
  packages/web/src` returns zero.
- **Both ends are tested and each fakes the other**, why this shipped green: `api/label.test.ts:52`
  manufactures the header from `app.capabilityToken`, which the browser cannot read, and
  `recordings/RenameControl.test.tsx:26` injects a `fetch` double returning 200. No test crosses the
  seam: none references `buildApp`, no `e2e/` exists.
- **A law pins the defect**: `replay/mutating-calls-law.test.ts:167-173` requires every `headers:`
  block in `label.ts` to be exactly `'Content-Type':'application/json'`, and `LabelFetchLike`
  (`recordings/label.ts:34-37`) has nowhere to put another.
- `server/mutation-guard.ts:136` returns early outside POST/PUT/PATCH/DELETE, so **every GET skips
  the loopback `Host` check** — `/api/stream` and `/api/transcript/:lane` included; its comment
  defends this because CORS blocks a cross-origin read, the assumption rebinding removes (#235).
  ADR-0008 records both holes; SECURITY.md states the fence without them (#238).

## Success

1. Every command route refuses a tokenless request, **and** every mutation the dashboard offers
   succeeds against a real server. **Not met while** a shipped control 401s, a command route answers
   2xx untokened, or a mutation's two ends are proven only by mutual fakes.
2. No route discloses machine facts to a rebound origin. **Not met while** `GET /api/stream` or
   `/api/transcript/:lane` answers a non-loopback `Host`.
3. Coverage is structural: a route added without a declared class fails a test. **Not met while**
   coverage rests on an author remembering, or the law's own walk can go vacuous.
4. The prose matches the code. **Not met while** SECURITY.md, README's Trust section or
   `api/security.ts:26-32` promises a control the code lacks.

## Non-goals

- **No accounts, passwords, OAuth, stored credentials, TLS, multi-user authorization model, remote
  access, or cloud.** "No auth, no cloud, no accounts" stands, unchanged.
- **No new hand.** The read-only constitution stays AMENDED, not dissolved (prd-12 ruling 1,
  ADR-0001); prd-20 ruling 1 owns the fourth hand and its amendment.
- Not #234's `model` grammar (it ships inside #234), not #216's redaction residue, not #244, not
  #218, not where the lab lives — ruling 7.

## Rulings

Each is a **proposed verdict and its reasoning**, not a blessed posture: no operator has ruled on any
of it, and the subject is security-adjacent. Rejected throughout: **a password or login** (accounts
by another name; whoever reads loopback reads the login page); **loopback binding alone** (ADR-0008's
rejected option C); **a CORS allowlist or signed origins** (rebinding makes the origin same-origin,
so signing an attacker-chosen name proves nothing); **an out-of-band token** from a boot log (honest,
and it leaves every shipped control unusable).

## Ruling 1 — the token reaches the browser in the served HTML, and the claim shrinks to match

`server/static.ts` injects the per-process token into `index.html` at serve time — not `/api/meta`,
which `ci.yml:124` already `cat`s to the build log. But no in-band channel defends against the
attacker `api/security.ts:1-15` names, since a local process reaching loopback can fetch the HTML
too, so the claim narrows to "stops a caller that can send but not read, and stays out of logs".
**A human must accept that narrowing, or accept out-of-band delivery and an unusable button.**
**ADR-owed**, superseding or amending ADR-0008, with `api/security.ts:26-32` rewritten to match.

## Ruling 2 — the narrow fetch type admits one more named header; the law is tightened

`LabelFetchLike` widens to a closed two-header literal, never `Record<string, string>`, keeping the
property its doc names — *"nowhere to put"* a credential. The pinning law is amended as a
**tightening** to that fixed shape, credential bans at `:163-165` intact, in its own commit.

## Ruling 3 — in-band delivery makes #235 a prerequisite, not defence in depth

The token's secrecy becomes only as good as the weakest read: a rebound origin that reads any GET
reads the token. That page still cannot mutate, since the browser writes `Origin` and `Host`, so this
is a secrecy loss and not a mutation path — but one the token's doc says cannot happen. #235 lands
*with* #249, never after it.

## Ruling 4 — the loopback `Host` law becomes universal, for every method

`MUTATING_METHODS` stops gating the `Host` check; `Origin` and `Content-Type` stay scoped to mutating
methods. #284 (#253) opts `GET /api/doctor` into that check by itself — the right instinct at the
wrong altitude, so **generalize it, then delete it**: a guard each route must remember is the guard
forgotten on five of six.

## Ruling 5 — three route classes, enforced by a law; incremental adoption is retired

Every route declares itself **read**, **command**, or **inbox** — reads get the `Host` law, commands
that plus the token, the inbox is ruling 6 — and a law enumerates registered routes, failing on an
unclassified one or a command missing its preHandler, with a count assertion (two laws here have
already walked vacuously). `api/security.ts:64-71`'s "adoption is deliberately incremental" fence
produced the tokenless `/api/rotate`; #234 applied alone would gate rotation, which the dashboard
also calls — the same defect twice. So delivery, coverage and the `Host` law land together under one
adversarial review, and the taxonomy is part of ruling 1's ADR.

## Ruling 6 — the inbox stays unauthenticated, by design and on the record

`/v1/metrics`, `/v1/logs` and `/v1/traces` are POSTs from foreign agent processes. Threading a
per-process token into every lane's env block fails: it dies with the server while that block does
not, so one restart would silently kill all telemetry — the invisible failure prd-19 exists to end.
The inbox keeps instance-id attribution and its `telemetry.refused` record, which is why success 1
says *command* routes.

## Ruling 7 — #245 is not ruled here

Whether the lab separates structurally or is extracted outlives this PRD: `api/lab.ts:361`'s dynamic
import walks through a fence `lab/namespace-law.test.ts:152` cannot see. **That needs an ADR and a
lead's decision**; #234's patches ship regardless.

## Sequencing (waves, each gated as ever)

0. **Keystone, fenced apart but landing together:** #249 (delivery, widened type, amended law, one
   test crossing the seam) · #235 (universal `Host` law).
1. **#234** — the token on `/api/rotate` and `/api/lab/launch`, plus its `model` grammar; parked at
   Backlog awaiting #249, this is where it returns.
2. **Three new issues, described and unnumbered:** ruling 5's route-class coverage law, which also
   deletes #284's route-local preHandler · the record (the ADR, the `api/security.ts` rewrite, the
   SECURITY.md / README Trust section, extending #238) · a seam-test harness beyond #249's one case.

**prd-20 ruling 2's gate opens once waves 0-1 and the coverage law land**; #260/#262/#264 wait there.

## Open questions

- **Dev mode.** `vite dev` serves `index.html` itself, so nothing injects the token: every mutation
  401s in development. Dev-only token, proxy, or honest refusal — open, not ruled.
- Whether the token stays per-process or rotates with the session (`/api/rotate` mints a new session
  id; the token does not move), and whether the ADR supersedes ADR-0008 or amends it.
- The instance id sits on an ungated `GET /api/meta`, so a local process can read it and forge
  exports. Ruling 6 accepts that; nobody has ruled it.
