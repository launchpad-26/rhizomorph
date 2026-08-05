You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

You are building the KEYSTONE of prd15 — the organ every future adapter
implements against. docs/prd15.md is BLESSED and binds you; the two spike
notes it cites are your evidence base. Derivation over inference, purity
over cleverness, real transcripts over synthetic ones.

YOUR ISSUE — #188:

## Direction

**prd15 wave 1 — THE KEYSTONE.** Read `docs/prd15.md` IN FULL (it is
blessed; ruling 1 is your charter), then
`docs/research/2026-08-05-agnosticism-spike.md` §1 and
`docs/research/2026-08-05-agnostic-adapters-spike.md` (the floor ladder and
the adapter contract).

Build **the transcript-tail state machine**: lane liveness and attention
derived from the one artifact every agent CLI must produce — its session
transcript — with ZERO cooperation from tmux, hooks, or the agent itself.

1. **The organ is a pure derivation** over three inputs the sessionlog
   collector already has or can cheaply add: (a) the transcript tail's TURN
   SHAPE (claude JSONL grammar first — is the last entry a completed
   assistant turn? a pending tool_use? mid-stream?), (b) file-write recency,
   (c) process aliveness (a probe utility living inside this collector's
   directory; argv-only, read-only, portable — state your Windows/WSL/macOS
   strategy).
2. **States**: WORKING (growing / mid-turn), WAITING (turn complete, nothing
   pending — the needs-you signal), FROZEN (process alive, file stalled
   mid-turn), GONE (process dead, file stalled — git state disambiguates
   done-vs-died downstream). Thresholds start from the tmux collector's
   proven constants; name them at the top with their law comments.
3. **Emit through the EXISTING event union** (the adapter contract: no new
   event types from an adapter). `agent.status` is the natural home — if a
   field you need is missing from it, print `BLOCKED: <need>`; do not mint
   an event type on your own initiative.
4. **Two witnesses, never a silent winner** (prd15 ruling 2's law): where
   tmux/workmux signals exist for the same lane, BOTH observations flow;
   disagreement is a voiced fact, not a resolved one. The #133
   false-summons replay fixtures MUST stay green — a lane mid-subagent-
   delegation (quiet transcript, alive process, mid-turn shape) must not
   summon.
5. **Fixtures from REAL transcripts** — the repo's own 160+ lane transcripts
   are the corpus; pin the claude turn-shape grammar from them
   (dialect-verification discipline: the grammar is a versioned capture,
   not documentation). Codex/pi grammars are LATER lanes — do not build
   them; the grammar module must simply be per-CLI pluggable.
6. **Prove the tmuxless boot**: a test that runs this collector with no
   tmux/workmux present and derives correct states from fixture transcripts
   + a stubbed process probe. This test is the prd's whole point in
   miniature.

Laws, test-stated: derivation pure and deterministic (same inputs → same
states, byte-equal); prefix-consistency (state at T from a truncated
transcript equals state at T from the full one — the replay law applied to
liveness); no false summons on the #133 corpus; zero writes anywhere (the
observer's constitution — the probe reads /proc or its platform equivalent,
never touches the observed process).

## Fence (may touch ONLY)

- `packages/server/src/collectors/sessionlog/` (all files)

## Blocked by

Nothing. #187 owns `log/`, `cli/`, `api/meta` — if the boot wiring needs a
line there, `BLOCKED: <need>`. **Model:** opus (keystone precedent — this
organ is the contract every adapter implements against). **Wave:** prd15
wave 1.

## Definition of done

- States derived from real-transcript fixtures, tmuxless, all laws
  test-stated; the pluggable grammar seam named; thresholds documented.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
