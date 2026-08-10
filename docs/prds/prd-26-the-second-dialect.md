# prd-26 — the second dialect: adapters for the harness you actually drive

> **Status:** proposed — the build of prd-15 ruling 4 (the adapter contract) and
> ruling 3 (provider/model/cost parity), not a redesign of either.

## Problem

The instrument reads exactly one agent CLI. Somebody driving codex, pi, aider,
Gemini CLI or Cursor gets their git and their panes, and is blind to their
agent's words, tokens and money — with no sentence anywhere saying why. The code
is honest and the screen is not: `grammarFor('codex')` returns `null` by design,
and `sessionlog` disables itself reading *"no Claude Code session log directory
at …"* — true, and useless to somebody who never installed Claude Code. What
they see is a lane with no conversation, no tokens, no dollars and no named
cause: an idle agent and an unseeable agent looking alike, the exact confusion
the honest-gap discipline exists to prevent. The people paying are the
handover's audience — a cohort on fresh machines, no author in the room.

## Evidence

- **The contract is ruled; its build was never filed.** prd-15 (blessed
  2026-08-05) ruling 4 *"the adapter contract is law"*, ruling 3
  *"provider/model/cost parity across CLIs"*; rulings 1 and 5 landed (#188,
  #190), wave 4 (*"Codex adapter, then pi"*) has no issue. The roadmap reserves
  the rest: *"what remains cohort-inheritable is building the adapters against
  it, not designing the contract."*
- **The honesty vocabulary exists and is used well.** `SESSIONLOG_CAPABILITIES`
  declares `cost: absent` — *"the transcript carries tokens, never dollars"*;
  `OTEL_CAPABILITIES` declares identity and cost `partial`, lane attributes
  proven for claude and *"untested for codex/gemini"*. ADR-0010 names the hole:
  *"declaration is not verification … Nothing checks that a collector declaring
  `provided` for a signal actually emits it."*
- **One dialect ships, on purpose** (`turn-grammar.ts`): *"a grammar written from
  documentation validates our reading of the docs, not the tool."* Turn shape is
  seamed; extraction is not — `parse-session-line.ts` is claude-shaped.
- **Per-harness reality, graded** (`docs/research/2026-08-05-agnostic-adapters-spike.md`):
  codex **[Ran — repo capture]** emits a private `codex.*` namespace, posts all
  three signals to the **bare endpoint path**, carries **no cost metric**;
  gemini-cli **[Verified — docs read, never captured]** is closest to the GenAI
  conventions but defaults to gRPC on 4317 and offers a `telemetry.outfile` file
  drop; codex's `~/.codex/sessions/` rollouts are **[Thin — not captured]**;
  `OTEL_RESOURCE_ATTRIBUTES` honoring is untested for both. And
  `packages/server/src/api/otel.ts` serves `/v1/{metrics,logs,traces}` only, so
  codex's verified export lands nowhere today — read from the routes, not assumed.
- **Evidence limit, plainly.** The note those codex facts come from
  (`research/2026-08-03-trace-era-captures.md`) is cited seventeen times here and
  annotated *"[never committed]"* every time; claude's beta OTLP export (2.1.220,
  verdict GO) and codex's native OTel reach us second-hand only.

## Success

Falsifiable **per harness**, never in aggregate. Harness X is supported when a
session driven by a real X binary produces named lanes with correct lane/role
attribution (or the stable `UNATTRIBUTED_LANE`, never a minted per-restart id);
each of the six signals reads either a value or absent-with-a-reason-and-remedy;
and X has a row on `/connect` reading VERIFIED against a fact (prd-19 ruling 3).
**Not met while** X rests on a fixture not captured from the real binary; while a
signal X cannot supply renders as a zero, a blank or a silence rather than a
stated absence; or while X appears nowhere on `/connect`. A count of supported
harnesses is not a criterion.

## Non-goals

- **Not a redesign of the contract.** prd-15 rulings 3 and 4 stand as written,
  unrestated and unrenumbered; changing them is a new ruling in prd-15.
- **Not the launch surface.** prd-20 ruling 4 owns the `HarnessAdapter` seam
  (detect, env recipe, launch argv, continue argv) and its picker (#261): it owns
  how a harness is *started*, this PRD what the instrument *observes* once it
  runs, and the capability facts that picker shows.
- **Not every harness at once**, and never on documentation — a *[Verified — docs
  read]* harness is unbuilt, not supported.
- **No plugin API for out-of-tree adapters.** In-tree is reviewable, bound by one
  fixture suite, revertable in a commit; a plugin API is a published contract, a
  versioning obligation and a support burden a six-week cohort cannot carry — and
  it lets unreviewed code fabricate signal, the failure the gap voice exists for.
- **Rejected:** model-API proxying (LiteLLM/OpenRouter as a universal shim) —
  credential-bearing, critical-path, breaks the read-only constitution;
  pane-scraping as the general answer — attention only, needs tmux or a PTY,
  reads pixels for facts the transcript states; requiring harnesses to adopt OTel
  — Development-status conventions two of our three CLIs do not conform to.

## Rulings

Each is a **proposed** verdict with its reasoning. None is operator-decided;
where a human must rule, the ruling says so.

## Ruling 1 — native OTLP first; an adapter is the fallback, never the default

Where a harness exports its own OTLP the work is a **mapping profile plus an env
recipe**, not a collector: the receiver already ends at the event union, and
OTLP-the-protocol is a safe bet where GenAI-semconv-the-schema is not. So codex's
first task is receiver-side — bare-path body-shape routing, since its export
reaches `/v1/*` never. Route shape is architectural: **an ADR is owed**.

## Ruling 2 — capabilities are declared from the capture; the ladder degrades rather than lies

An adapter's `AdapterCapabilities` says what its fixture actually carries. No
tokens in the transcript means `telemetry: absent` with reason and remedy; no
cost metric means `cost` at most `partial`, flagged `est.`, per prd-15 ruling 3's
"no adapter may invent a cost". Nothing claims `provided` for a signal its own
fixture does not produce, and `deriveRung` still answers exactly one rung.

## Ruling 3 — verification-by-capture is the merge gate

No harness merges on documentation. Per the `dialect-verification` discipline: a
real **success** capture and a real **failure/absence** capture from the real
binary, version-pinned in the filename as claude's fixtures are; tests asserting
against those files, never inline synthetic JSON; assumptions labelled in source.
Each capture records exit behaviour on failure, whether roles are
distinguishable, **where usage and cost live and whether they are per-turn or
cumulative**, and whether the harness honors `OTEL_RESOURCE_ATTRIBUTES`.

## Ruling 4 — one harness per issue, one fixture set per issue, no diffs outside its own directory

Reviewable, revertable, fenceable for a swarm. Zero diffs outside
`packages/server/src/collectors/<x>/` and its fixtures — except an explicit core
PR **first** where the event union genuinely lacks a fact, additive by law.

## Ruling 5 — the shared seam is the one that exists; a second seam is an ADR, not a guess

`TurnGrammar` seams turn shape, and `grammarFor()` already refuses to read a
foreign transcript through claude's eyes. Usage/model/tool extraction is not
seamed; that split is named here as owed and left to **an ADR** — a second
interface beside `TurnGrammar` or one wider transcript-dialect interface is
structure outliving this PRD.

## Ruling 6 — an unimplemented harness is declared, never silent

Every harness the instrument knows the name of carries a status — implemented,
verified-unbuilt, declared-not-implemented — with its reason. A landed adapter
appears on `/connect` and `GET /api/doctor` as VERIFIED with a fact; an unlanded
one reads UNPROVEN or BROKEN with the reason (prd-19 rulings 3 and 5). prd-20
ruling 4 owns the picker rendering this, this PRD the content — never two rosters.

## Ruling 7 — codex is next on the evidence, and a lead rules the order

Codex is the only non-claude harness with a real capture in the repo's record,
and prd-20 ruling 4 already names it next for the registry — one harness, two
threads aligned. Then gemini-cli, whose `telemetry.outfile` needs no network
receiver; then pi, named in prd-15 ruling 3 and captured nowhere. **Proposed, not
decided** — the argument is the capture, never popularity.

## Sequencing (waves)

**No issue in this repo covers any of this**; searching adapter, codex, pi,
gemini, dialect and OTLP returns only adjacent work (#261, #277, #243, #192).
Each wave needs its own issue, filed against a live number read back from the
board — never a predicted one.

1. **Keystone:** the shared conformance suite prd-15 ruling 4 names, plus the
   declared-vs-emitted check ADR-0010 says nothing performs; sessionlog and otel
   run against it first, as the reference.
2. The extraction-seam split and its ADR (ruling 5).
3. Receiver route shapes and their ADR (ruling 1) — no harness mapping yet.
4. One issue per harness, capture first, in ruling 7's order once a lead confirms
   it: codex, gemini-cli, pi.
5. The declared-not-implemented roster (ruling 6), read by `/connect`,
   `/api/doctor` and prd-20's picker.

## Open questions

- **A citation drift, for a lead to settle.** The roadmap, prd-19's non-goals and
  prd-20 ruling 4 all cite *"prd-15 ruling 3"* for the adapter contract; prd-15's
  ruling 3 is the parity ruling, its ruling 4 the contract. Both are this PRD's
  foundation; neither is renumbered here — the numbers are load-bearing.
- Whether a flagged `est.` dollar should promote a lane to L1: `deriveRung` reads
  any non-`absent` cost as L1, so an estimate buys an authoritative number's rung.
- Live attention for a harness with neither hooks nor a pending-turn shape has no
  door below prd-15's L3 PTY wrapper (its wave 7, a COULD). Not ruled here.
- Whether an OTLP file drop (gemini's `telemetry.outfile`) is a collector or a
  receiver, per ruling 1's ADR. Open.
