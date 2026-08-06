# prd17 — the complete record: the instrument's judgements and the operator's decisions join the log

**STATUS: BLESSED** — operator, 2026-08-06, on the council's unanimous master
finding (`docs/research/2026-08-06-council/synthesis.md`): *the causal record
is missing its two most important actors — the instrument's own judgements,
and the operator's decisions.* prd1's founding insight ("orchestrated setups
undercount by omitting the orchestrator") recursed one level up: the operator
is the only unobserved agent in the system. Sequenced after prd16's waves
(they share the recorder seam, prd16 ruling 6); the UI dividend (digest,
inspectable landings, pins, calibration display, jump box, drill) is prd18.

## Ruling 1 — the new event families, all additive

- `summons.raised` / `summons.cleared` — the instrument's attention
  judgements become events (the attention chair: without them, summons
  precision, time-in-alarm, flood and chattering are uncomputable — exactly
  what ISA-18.2 audits an alarm system on; `tide/chapters.ts` already
  documents the gap in its own comment).
- `gate.verdict` — fence check result, load-batch tallies, hold-or-merge, the
  widened fence if any. `dispatch.brief` — lane, issue, fence, model at
  dispatch. `fence.declared` — the fence as data whenever the lane manifest
  changes (the systems chair's proof: today a recording contains NO fences,
  so a trespass can never be re-derived from the record).
- `operator.ack` / `operator.verdict` / `operator.note` — the human's acts,
  each **stamped with the log offset it was decided against**: who decided,
  when, seeing what. This is the answer to "a human clicked approve".
- `session.closed` — a session's end is an event, not an absence (also fixes
  a durability gap the systems chair named).

## Ruling 2 — ingestion is the beacon, the constitution is untouched

Gate.sh and dispatch.sh write one-line JSON beacons into the instrument's own
data directory; a beacon collector tails them (prd15 ruling 2's mechanism,
already blessed). Operator acts arrive via the UI (explicit human invocations,
the prd12/prd16 logic) or the CLI. Recording a decision is observation, not
conduction: the observer's read-only law over the watched repo is untouched.
The principles chair's split governs shape: **sidecar for content, event for
occurrence** — bulk content (a brief's full text) lives beside the log;
that-it-happened, with its digest, lives in it.

## Ruling 3 — recordings never rot (the integrity laws)

The systems chair's verified finding: the parser silently SKIPS unrecognized
events (the reducer's forward-compat arm is unreachable), and live folds
arrival order while replay folds ts-sorted through an order-sensitive
reducer. Therefore, as law:

1. **Lenient parse**: an unrecognized event line is COUNTED and VOICED
   (an honest gap: "N events from a newer era were preserved but not
   understood"), never silently dropped, and always preserved byte-for-byte
   in the log and the record.
2. **The golden era corpus**: one real recording per era, folded in CI by
   every future reducer — byte-identical state or the build fails. The one
   event-sourcing orthodoxy the repo had skipped.
3. **An identity `upcast()` chokepoint** reserved now between parse and
   reduce, so the day a migration is needed it has a home that every event
   already flows through.
4. **The fold-order law**: one fixture pins what order the reducer is owed
   and both paths (live arrival, replay ts-sort) are proven to satisfy it —
   or the divergence is ruled and documented. Cross-actor ordering for the
   forest anchors on the commit DAG (already captured via
   `commit.landed.parents`), never on wall clocks.
5. **Durability**: fsync on session close and rotation; the rotation crash
   ordering is stated and tested (close-then-open, never both-open).

## Ruling 4 — the timeline inherits the truth

Once the events exist: gate holds and merges become chapter marks; summonses
become marks with their clearances; the operator's verdicts appear where they
happened. No new surface — the existing mark lane and hover cards simply gain
the mark kinds they were always missing. (Everything richer is prd18.)

## Non-goals

No approval workflow, ever — recording decisions is not routing them. No
operator-surveillance framing: only acts the operator explicitly performs are
events; there is no idle tracking, no read-receipts on panels. No UI dividend
surfaces in this prd (digest, pins, diff view, calibration, jump box, drill —
all prd18). No second process.
