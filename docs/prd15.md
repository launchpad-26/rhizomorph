# prd15 — the anywhere instrument: true full-featured system agnosticism

**STATUS: DRAFT — awaiting operator blessing.** Direction ruled by the
operator 2026-08-05: *"I am aiming for TRUE, FULL FEATURED system
agnosticism"* — any OS, any terminal, any agent CLI, any provider, from an
eventual `npm install`. This supersedes the framing where tmuxless was a
degraded tier: **feature parity is the goal; tmux becomes optional
enrichment.** Evidence base: the three 2026-08-05 spike notes
(`docs/research/2026-08-05-{replay-ux,agnosticism,agnostic-adapters}-spike.md`)
and the trace-era captures.

## The distribution ruling (supersession on the record)

The 2026-08-03 "no npm publish" ruling (cohort advice, clone-first story)
is SUPERSEDED by the operator's 2026-08-05 direction ("what will eventually
be an npm install"). prd8's packaging work (tarball-proven allowlist,
tag-only release workflow, no secrets) is the machinery; the go-public
prerequisites remain #177's history decision and the stranger-run. Publish
is the LAST wave of this prd, never the first.

## Ruling 1 — the transcript-tail state machine is the universal organ

Every observable agent CLI writes a session transcript as it works. The
sessionlog family already tails them live; this prd makes the TAIL SHAPE a
state machine per lane:

- file growing → WORKING (with activity heartbeat = last-write recency)
- last entry a completed turn, nothing pending → WAITING (needs-you)
- process alive + file frozen mid-turn → FROZEN
- process gone + file frozen → DEAD/DONE (git state disambiguates)

This yields liveness AND attention with ZERO cooperation from the agent
stack — no tmux, no hooks, any terminal, any OS. Per-CLI turn-shape
grammars are adapter facts pinned by dialect-verification captures (claude
JSONL first — we know it deepest; codex rollouts and pi sessions behind
captures). The existing tmux-era detectors (prd3 r18 pathologies) restate
on this organ; thresholds start from the tmux collector's proven constants.

## Ruling 2 — hook beacons upgrade inferred to declared, where offered

A `beacon` collector tails a rhizomorph-owned directory of one-line JSON
events written by the agent CLI's own hook mechanisms (claude: Notification
/ Stop / PostToolUse hooks; codex: notify; pi: extensions). Declared
WAITING/activity beats any inference (#133's law, made universal). `rhizomorph
env <lane>` grows an optional `--hooks <cli>` emitter that prints the exact
hook config to install. Beacons and the transcript organ are two witnesses;
disagreement surfaces as an honest voice, never silently resolved.

## Ruling 3 — provider/model/cost parity across CLIs

Per-CLI adapters read model + token identity from the transcript itself
(origin tagging comes free: the transcript names model, session, cwd).
Authoritative dollars via OTLP where the CLI offers it (claude today);
estimated dollars via the SHA-pinned vendored pricing table (#129) flagged
`est.` exactly as built — pi-on-OpenRouter/Gemini lands here. OTLP remains
protocol-yes / GenAI-semconv-mapped-never-stored (adapters note, thread 1).
No adapter may invent a cost; absence stays an honest gap.

## Ruling 4 — the adapter contract is law

An adapter = name + presence probe + watch-a-directory + parse-a-format +
lane/role attribution rule + a capabilities manifest (which of {identity,
liveness, activity, attention, telemetry, cost} it provides; the UI's gap
voices read the manifest). Events ONLY from the existing union — the
reducer and UI are untouched per new adapter. Conformance = version-pinned
real captures of BOTH outcomes (dialect-verification discipline) + the
shared fixture suite. Sessionlog is the reference implementation. No
adapter grows its own state or UI.

## Ruling 5 — the enrichment ladder is named, not ranked

L0 zero-cooperation (git + process table + transcript organ: FULL core
experience) · L1 env (OTLP dollars/traces) · L2 beacon (declared attention)
· L3 PTY wrapper `rhizomorph run <cmd>` (terminal pixels + OSC ground for
VS Code signals; ConPTY on Windows) · L4 tmux/workmux (pane previews,
ATTACH one-keystroke). `doctor` and the provenance strip SAY the rung per
lane. ATTACH degrades honestly: without tmux it presents the lane's cwd +
resume command instead of a pane jump.

## Ruling 6 — multi-orchestrator honesty (from the agnosticism note §3)

One root-mass forever — the mass is the REPO. `selectConductors` (distinct
conductor identities in-window); a provenance voice ("2 conductors seen");
conductor lanes render as a distinct family when N>1 instead of silently
summing; the conductor-not-instrumented gap goes per-conductor;
`telemetry.refused` gets state + a voice (a second-instrument tell, dropped
today); the default-lane collision (`rhizomorph env conductor` twice)
closes. #187's liveness guard is the prerequisite (in flight). Live
federation stays OUT — records/ACTOR (prd11) remain the cross-instrument
answer.

## Ruling 7 — Windows-native is verified, never assumed

A named verification pass on Windows Terminal + PowerShell native (paths,
process probing, transcript locations, ConPTY for L3), producing captures,
not confidence. macOS gets the same via the cohort. The support matrix in
the README moves rows only on evidence.

## Sequencing (waves, each gated as ever)

1. **Keystone: the transcript-tail state machine** for claude sessions
   (organ + laws + fixtures from real transcripts; the tmux collector's
   detectors restated against it).
2. Capabilities manifest + gap-voice rewiring + doctor rungs (ruling 5's
   honesty layer).
3. Beacon collector + claude hooks emitter (capture first).
4. Codex adapter, then pi (capture first, pricing-table estimates wired).
5. Multi-orchestrator family (ruling 6, behind #187).
6. Windows leg (ruling 7).
7. PTY wrapper (L3) — COULD, after everything above.
8. Publish gate: #177 history decision → public repo → `npm publish` via
   the prd8 workflow.

## Explicit non-goals

No live cross-instrument federation (records only). No SDK, no code
injection into observed agents — rhizomorph observes; it never instruments.
No per-CLI UI: one UI, adapters feed it. No semconv schema bet.
