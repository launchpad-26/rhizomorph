# Full system agnosticism — tmuxless, other-CLI, multi-orchestrator

> Researched 2026-08-05 for the operator's next-frontier ruling: rhizomorph
> must work on tmuxless setups, OpenClaw setups, other agent CLIs, and answer
> "what if there is more than one orchestrator — do we display that? how do we
> know?" Claims graded [Ran] / [Verified] (primary source read or checked this
> session) / [Read] (reasoned directly from repo source read this session) /
> [Hypothesis]. Repo read-only at `\\wsl.localhost\Ubuntu\home\lachlan\worktrees-challenge`.

## Headline verdicts

1. **[Read] Agnosticism is more landed than assumed.** Every collector
   self-disables cleanly (`collector.disabled` + resilience retry), doctor
   already treats tmux/workmux as *optional* tools, and the fold's
   detectors mostly read telemetry, not panes. A tmuxless boot today is a
   working, honestly-degraded instrument — not a broken one. What actually
   dies tmuxless is exactly two signals: **live pane liveness** and the
   **declared/inferred WAITING** pathology.
2. **[Read] The adapter thesis holds structurally.** The `Collector`
   interface is `name + initialSnapshot() + poll(prev, ctx) → {nextSnapshot,
   events[]}` (`packages/core/src/collector.ts:87`), the reducer survives
   unknown event types, and the sessionlog collector is already the
   watch-a-directory + parse-a-format archetype. New CLIs are adapters, not
   rewrites — the cost per adapter is a directory layout, a JSONL schema, a
   lane/role attribution rule, and fixtures.
3. **[Read] Multiple orchestrators do not crash anything — they silently
   merge.** All conductor-role spend folds into the ONE root-mass
   (`isRootSpend`, `packages/web/src/fleet/buildFleet.ts:594`); `selectRoleSpend`
   sums every conductor into one bucket; the scene draws one MAIN. Detection
   is possible from data already stored (distinct conductor lanes/sessions);
   display and the gap voice are what's missing.
4. **[Read] The genuinely dangerous multi-instance case is not OTLP — it's
   the session file.** The OTLP receiver verifiably refuses foreign instance
   ids (`packages/server/src/api/otel.ts`), but `decideSessionBoot` has no
   liveness check: a second `rhizomorph` started on the same repo within the
   resume window resumes the FIRST instance's live session file and both
   processes append to it — under the same instance id.

---

## 0 — Collector census (ground truth)

All collectors live in `packages/server/src/collectors/`; git/tmux/workmux/judge
are wired in `server/collector-loader.ts`, sessionlog in `cli/index.ts:196`,
otel is not polled at all — it is the HTTP receiver (`api/otel.ts`). Every
polled collector is wrapped in `withResilience` (3 consecutive failures to
disable, 30s re-probe, self-heals — `collectors/resilience.ts`) and
`withResumeReconciliation`.

| Collector | Emits | Requires | Dies without it |
|---|---|---|---|
| **git** (`git/git-collector.ts`) | `worktree.discovered/removed`, `branch.updated`, `commit.landed` (author, files, diffstat), `worktree.dirty` | `git` binary + a git repo. Nothing else. | The whole instrument — repo geography, lanes' place, commits, dirty sets. Also note: **sessionlog runs `git worktree list` itself** (`sessionlog/collector.ts:111`) — no git means sessionlog disables too. |
| **tmux** (`tmux/collector.ts`) | `pane.discovered/closed`, `pane.activity` (content-hash delta, line count, last-line preview) | `tmux` binary + a running server; panes matched to worktrees via `git -C <pane_cwd> rev-parse` | Pane liveness (`lastEventTs` collapses to `lastWorkTs`), the last-line preview, and the **inferred WAITING** pathology (`detectWaiting` returns null when `paneActivityTs === null`, `buildFleet.ts:955`) |
| **workmux** (`workmux/collector.ts`) | `agent.status` (working/waiting/done + branch + worktreePath + elapsed) | `workmux` binary (which itself requires tmux) | The **declared WAITING/done** status — the only *certain* raised-hand signal; `activityOf`'s `done` reading falls back to worktree-removal only |
| **sessionlog** (`sessionlog/collector.ts`) | `llm.usage` (4-tier tokens, model, requestId, sessionId, branch, cwd, thread via `isSidechain`), `tool.activity` (+`filePath`, `toolUseId` — prd11) | `~/.claude/projects/<slug>/*.jsonl` (Claude Code's layout; slug derived from worktree path by `worktree-slug.ts`), plus `git worktree list` for discovery; `--extra-sessions <dir>[:lane]` tails any literal dir as conductor | Tokens/tools/threads per lane, the branch half of the cost join, provenance (filePath/toolUseId), LOOPING evidence |
| **otel** (`api/otel.ts` + `collectors/otel/*`) | `llm.usage`, `llm.cost` (the ONLY dollars), `agent.activeTime`, `trace.span` (waterfall, `tool.blocked_on_user`), `telemetry.refused` | The agent CLI must *export* OTLP http/json with `OTEL_RESOURCE_ATTRIBUTES=lane,role,instance` (attached at launch, never retroactively — `docs/telemetry.md`) | Dollars everywhere (tokens remain), activeSeconds, the trace waterfall, retrospective waited-on-human |
| **judge** (`judge/collector.ts`) | `judge.finding` (symbol-overlap, speculative-conflict; severity `log`) | `git` only (merge-tree + diffs), 60s cadence | Collision early-warning |

**[Read] Degradation is already loud, per collector.** `buildGaps`
(`buildFleet.ts:1154`) emits `<NAME> COLLECTOR DISABLED — <reason> — run:
rhizomorph doctor` for every disabled collector, plus `NO COST FEED`,
`CONDUCTOR NOT INSTRUMENTED`, `UNATTRIBUTED SPEND`, `NO LANE MANIFEST`.
`rhizomorph doctor` (`cli/doctor.ts:69`) checks tmux and workmux via
`checkOptionalTool` — they can only ever `warn`, never `fail` (the failing
set is `target-path`, `web-build`, `port` only). The junior audit already
proved the bare no-workmux case reads "absent-on-purpose, not broken"
(`research/2026-08-03-trace-era-captures.md` §5).

---

## 1 — Tmuxless reality

### What survives on a plain terminal (macOS Terminal, VS Code, Windows)

[Read], traced through `buildFleet.ts` detector by detector:

- **Lanes and geography** — fully alive (git collector; worktrees, branches,
  commits, dirty sets, ahead/behind).
- **Spend/tokens/threads/models** — fully alive (sessionlog needs only
  `~/.claude/projects`; OTLP needs only env vars at launch; both are
  terminal-independent). The cost→branch `sessionId` join is unaffected.
- **FROZEN** — alive: reads `ageMs` off `lastEventTs`, which tmuxless equals
  `lastWorkTs` (telemetry + spans + commits). Arguably *more* honest tmuxless:
  a pane repaint can no longer postpone FROZEN.
- **LOOPING** — alive (`tool.activity` cycles vs `commit.landed`).
- **EXPENSIVE** — alive (spend rates).
- **OFF-FENCE** — alive if a manifest exists (`.swarm/lanes.json` +
  `tool.activity.filePath`).
- **Retrospective waited-on-human** — alive *when traces are enabled*:
  `tool.blocked_on_user` spans arrive over OTLP after each span ends
  (prd9 ruling 6) — no terminal involvement at all.
- **activity (working/idle/done)** — mostly alive: `activityOf`
  (`buildFleet.ts:1549`) reads `agentStatus` (dead), presence (alive), and
  `workAgeMs` (alive). Lanes read working/idle/unknown correctly; `done`
  degrades to "worktree removed".

### What dies, precisely

1. **Declared WAITING** (`agent.status: waiting` from workmux) — the only
   certain live raised-hand signal. [Read: `detectWaiting` first branch.]
2. **Inferred WAITING** ("quiet lane, live pane") — needs `paneActivityTs`. [Read]
3. **Pane previews** (last non-empty line) and `pane.discovered/closed`.
4. Workmux's `done` declaration (lands as worktree-removal detection instead,
   which fires later).

So the honest tmuxless story today is: **everything but LIVE attention.** The
attention strip still ranks FROZEN/LOOPING/EXPENSIVE/OFF-FENCE; what it
cannot say tmuxless is "this lane is sitting on a permission prompt right
now."

### Terminal-agnostic liveness alternatives, graded

| Route | Intrusiveness | Signal | Notes |
|---|---|---|---|
| **OTLP-as-heartbeat** (already flowing) | none (env already required for dollars) | medium | Metrics export every 5s, logs 2s while a session is alive (`docs/telemetry.md` env block). "Recent OTLP traffic = process alive" is free. Cannot distinguish waiting from dead between turns. [Read] |
| **Sessionlog append cadence** (already flowing) | none | medium | Already `lastWorkTs`. Gaps during long tool runs; no waiting signal. [Ran, in-product] |
| **Agent-CLI hooks as an attention beacon** | low (one-time config, no process wrapping) | **high, exact** | Claude Code's hook system fires on permission-request/idle notifications and on tool lifecycle; a hook that appends one JSON line to a well-known dir (`~/.local/share/rhizomorph/beacons/`) gives a *declared* live WAITING with zero terminal dependency — the CLI itself says "hand up," which is stronger than tmux inference ever was. [Hypothesis — hook events exist per Claude Code docs; exact event names and payload need a dialect-verification capture before build. Trace-era note §1 already confirms adjacent hook *spans* exist behind `ENABLE_BETA_TRACING_DETAILED`.] |
| **OS process inspection** (pgrep/`/proc/<pid>/cwd`, `proc_pidinfo`, Windows `Get-Process`) | low (read-only, but platform-forked) | low-medium | "alive vs gone" + cwd→worktree mapping on Linux via `/proc/<pid>/cwd`; macOS needs lsof; Windows cwd is effectively inaccessible without native calls. No waiting signal, no content. Reasonable as a *liveness* backstop, poor as an attention source. [Read/Hypothesis — not run this session] |
| **VS Code shell-integration escape codes** (OSC 633/133) | n/a from outside | high in-band, **zero out-of-band** | The codes mark command start/end *inside the terminal's own stream*; an external read-only process cannot read another terminal's PTY. Useful only if rhizomorph owns the pipeline — i.e. collapses into the wrapper row below. [Read — architectural, not testable from outside] |
| **PTY wrapper** (`rhizomorph run <cmd>` via node-pty; ConPTY on Windows; or `script -f <file>`) | **medium-high** (changes how the operator launches the agent) | **highest** | Full pane-equivalent stream: content-hash liveness, last-line preview, prompt detection, works in any terminal incl. Windows. `script -f` writing a tailable typescript file turns it into exactly the sessionlog pattern: wrapper writes a file, a collector tails it — no daemon coupling. Precedent: the product already intervenes at launch (`rhizomorph env`, `.workmux.yaml` panes block), so a launch-time wrapper is the same class of ask, not a new one. [Hypothesis] |
| **asciinema rec** | medium-high | high | Same as PTY wrapper but a foreign format + no Windows ConPTY story; no advantage over owning the wrapper. [Read] |

**Minimum honest tmuxless story (proposed):** ship nothing new and say so —
the two gap voices (`TMUX COLLECTOR DISABLED`, `WORKMUX COLLECTOR DISABLED`)
already name the loss, but neither says *what* was lost in product terms.
One copy change makes the degradation legible: "live waiting detection
unavailable — attention is retrospective only (traces) — run: tmux, or wire
the hook beacon." Then the hook beacon is the cheapest real replacement, and
the PTY wrapper is the completionist one.

---

## 2 — OpenClaw and other-CLI setups

> External findings below were gathered by two delegated web-research passes
> this session; grades follow theirs ([Verified] = primary repo/docs fetched).

### OpenClaw — what it actually is today

PENDING-AGENT-A

### Codex CLI session artifacts

PENDING-AGENT-B-CODEX

### gemini-cli session artifacts

PENDING-AGENT-B-GEMINI

### The thesis: "the event log is the product; collectors are adapters"

**[Read] Structurally confirmed in the codebase.** Evidence:

- The whole product is one append-only event log + pure fold
  (`docs/architecture.md` §"event-sourced core"); every surface (fleet table,
  scene, attention strip, burn strip, replay, the portable record) reads the
  same stream. A new source only has to *emit events*; nothing downstream
  changes.
- The `Collector` contract is four members (`packages/core/src/collector.ts:87`);
  the sessionlog collector already IS the generic adapter shape: watch a
  directory → tail files by offset → parse lines → emit `llm.usage` /
  `tool.activity` with lane/role/thread attribution. An adapter per CLI is a
  new `parse-session-line.ts` + a directory-layout rule + a slug rule.
- The reducer tolerates unknown event types (prd11 ruling 3: "the reducer
  already survives unknown types"), and the otel parser's stance ("map
  gen_ai.* where present, never adopt as storage schema"; unknown span names
  → `other`) is the same discipline adapters need.
- The record format is explicitly emitter-agnostic: the hash chain covers
  `line` as opaque text, "a compatible emitter for a different event schema
  can reuse this exact record format unchanged" (`docs/record-format.md` §body).

**Per-adapter cost model** [Read + external findings]:

| Adapter | Watch | Parse | Attribution | Gaps to declare | Est. relative cost |
|---|---|---|---|---|---|
| claude sessionlog | `~/.claude/projects/<slug>/` | shipped | shipped | — | shipped |
| codex sessions | see agent findings below | rollout JSONL | lane from cwd; role must be declared (no OTEL_RESOURCE_ATTRIBUTES confirmation — open question from trace-era note §2) | **no cost anywhere** (pricing-table estimate or honest gap); bare-path OTLP posts need body-shape routing | small-medium |
| gemini sessions | see agent findings below | logs/checkpoint JSON | lane from project hash→path mapping | telemetry config differs; verify token fields | small-medium |
| OpenClaw | see agent findings below | session JSONL | agent-id ≠ repo-lane: needs a mapping rule | likely no per-repo worktree geography — git collector carries it | medium |
| PTY/hook beacon (any CLI) | `~/.local/share/rhizomorph/beacons/` | one-line JSON | lane declared at wrap time | — | small |

The adapter interface worth naming in a prd: `watch(rootDirs) + parse(line) →
RhizomorphEvent[] + attribute(file, line) → {lane, role, sessionId}`, with
fixtures pinned per CLI version (the fixture-hygiene law already exists for
otel: `collectors/otel/fixture-hygiene-law.test.ts`).

---

## 3 — Multiple orchestrators

### What exists today, precisely

- **One MAIN by construction.** `Fleet.root: RootMass` is singular
  (`buildFleet.ts:492-495`); the scene grows everything out of one root-mass
  (`scene/geometry.ts`, `scene/marks/root.ts`). `isRootSpend`
  (`buildFleet.ts:594`) sends every lane whose dominant role is `conductor` —
  or whose branch is main — into that one mass: their handles join
  `rootHandles`, their output tokens sum into `root.conductorOutputTokens`,
  and **they never become lanes**. [Read]
- **One conductor bucket in the fold.** `selectRoleSpend`
  (`packages/core/src/selectors/spend.ts:537`) accumulates per role;
  `overheadRatio = conductor.output / worker.output`. Two conductors are
  indistinguishable from one busier conductor in every headline number. [Read]
- **The gap voice can be satisfied by half the truth.** `conductor-not-
  instrumented` fires only when *zero* cost records carry `role: 'conductor'`
  (`buildFleet.ts:1203`) — one instrumented conductor of two silences it. [Read]
- **Multi-conductor is already half-anticipated at the edges.**
  `--extra-sessions` is repeatable and auto-names lanes `conductor`,
  `conductor-2`, `conductor-3`… (`sessionlog/collector.ts:232`,
  `docs/telemetry.md`); `rhizomorph env <lane> --role conductor` accepts any
  lane name. The *data* can carry N conductors as N lanes today — the fold
  then erases the distinction at the root-mass. [Read]
- **prd11's ACTOR is for federation, not live co-orchestration.** `Actor
  {instance, handle, declared}` names the *recording instrument*, not an
  orchestrator; `mergeRecords` interleaves two instruments' records
  per-actor-append-only (`packages/core/src/record/merge.ts`) — the offline
  answer to "two humans, two rhizomorphs, one repo," not the live one. [Verified — read schema + merge + record-format.md]

### How the instrument could DETECT two orchestrators

1. **Two conductor-role telemetry identities.** Strongest signal: distinct
   `(lane, sessionId)` pairs with `role: 'conductor'` active inside the same
   window. Every `llm.usage`/`llm.cost` already carries `sessionId` and
   `lane`; `selectLaneRoleSpend` already answers "conductor spend within lane
   X" per row (`spend.ts:277`). A selector `selectConductors(state, window)`
   → distinct conductor identities is derivable from stored state with no new
   events. [Read]
   - Trap: two conductors wired with the same lane string `conductor` merge
     into one lane row — the string, not the session, is the map key. The
     sessionId still splits them; the *default* lane name is the collision.
2. **Two session-log roots** — two `--extra-sessions` dirs already yield
   `conductor` and `conductor-2` lanes. Declared, so reliable; but purely
   operator-supplied. [Read]
3. **Branch-creation provenance** — weak today: `branch.updated` carries no
   actor; `commit.landed` carries git author, which distinguishes *humans*
   (or bot identities) but not orchestrator processes; the lane manifest
   `.swarm/lanes.json` is a single file whose writer is anonymous —
   two dispatching conductors would silently last-writer-win it. Provenance
   would need a manifest field (`dispatchedBy`) or prd11 provenance chaining,
   not inference. [Read]
4. **Foreign-instance refusals as a tell** — a second *rhizomorph+conductor*
   pair mis-pointed at this receiver produces throttled `telemetry.refused`
   events (1/offender/min, `api/otel.ts:154`) — but the fold currently drops
   them (`reduce.ts:97-101`: "#62 gives it a home in state" — no home yet)
   and no gap voice reads them. Today a refused second orchestrator is
   visible only by reading the raw log. [Read]

### What SHOULD it display (options, with the codebase's own grain)

- **Not two root-masses.** The scene's whole geometry is distance-from-the-
  one-mass = lifecycle (`geometry.ts` header); a second mass breaks every
  invariant (born radius, bundle radial, camera). High cost, low honesty gain.
- **An orchestrator lane family** fits the existing grain: conductors already
  *are* lanes in the spend fold; buildFleet chooses to fold them into root.
  Keeping ONE root-mass (the repo's main — which is what the mass actually
  is: `RootMass.mainBranch`, commits home, landings) and rendering N
  conductor lanes as a visually distinct family (prd10 ruling 9's conductor
  bud already draws conductor-side subagent activity off the mass) is
  additive. [Read]
- **A provenance-strip voice is the cheapest honest step**: "2 conductors
  seen (conductor, conductor-2) — overhead ratio pools both" next to the
  existing overhead figure, plus a gap voice when conductor count is
  ambiguous (conductor-role spend under one default lane string from two
  sessionIds).
- The overhead ratio's *definition* survives N conductors (sum of conductor
  output ÷ sum of worker output is still meaningful) but the label should
  say "2 conductors" once detection exists.

### The adjacent case: two rhizomorph instances, one repo

- **[Verified] The OTLP receiver refuses foreign instance ids** — all-or-
  nothing per body, 403 with a self-explaining message, `telemetry.refused`
  recorded throttled (`api/otel.ts:169-176`, `:217-220`). A lane's env block
  carries exactly one endpoint + one instance id, so its OTLP stream reaches
  exactly one instrument; the other shows `NO COST FEED` honestly. Sessionlog
  tailing is read-only and concurrent-safe by nature — both instruments see
  tokens.
- **[Read] The unhandled hazard is the shared session file.** Session logs
  are keyed by repo slug (`~/.local/share/rhizomorph/<slug>/`);
  `decideSessionBoot` (`server/src/log/session-log.ts:217`) resumes the most
  recent session younger than the window with **no check that another
  process is still writing it**. A second instance started on a different
  port while the first runs will: (a) resume the same sessionId → **both
  instruments share one instance id**, so the receiver-refusal protection
  cannot tell them apart; (b) both append to one JSONL file; (c) the
  resumed writer *drops the file's trailing partial line* on open
  (`SessionLogWriterOptions`, `session-log.ts:9-15`) — it can eat a line the
  live writer is mid-appending. Not run this session — flagged as the first
  thing a multi-instance prd must test. [Read; downgrade to Ran after a
  two-process probe]

---

## Candidate ruling list for a future prd (for the operator to bless)

1. **Tmuxless is a supported tier, named in the product.** Ship no new
   collector; upgrade the two gap voices to say what was lost ("live waiting
   unavailable — attention is retrospective (traces) until tmux or a beacon
   exists"). Evidence: §1 — every detector except WAITING survives;
   doctor already treats tmux/workmux as optional.
2. **The attention beacon is the tmuxless WAITING answer: agent-CLI hooks
   writing one-line JSON to a rhizomorph-owned dir, tailed by a tiny
   collector.** Declared > inferred — it retires tmux *inference* even where
   tmux exists. Commission a dialect-verification capture first (hook event
   names/payloads, per CLI). Evidence: §1 table; sessionlog pattern reuse.
3. **A PTY wrapper (`rhizomorph run <cmd>`) is the completionist tmuxless
   liveness route — COULD, behind the beacon.** It is the only route to
   pane-equivalent previews on plain terminals and Windows (ConPTY), and the
   only home VS Code OSC 633/133 signals can ever reach. Evidence: §1 grading.
4. **Bless the adapter interface: watch-a-directory + parse-a-session-format
   + attribution rule, fixtures pinned per CLI version.** Sessionlog is the
   reference implementation; codex and gemini adapters are SHOULD/COULD per
   the cost table; OpenClaw per §2 findings. The event log stays the product;
   no adapter may grow its own state or UI. Evidence: §2 thesis.
5. **Codex dollars stay an honest gap until the pricing rip lands** (its
   telemetry carries no cost — trace-era note §2 [Ran]); the vendored
   Langfuse price table (SHA-pinned, MIT) is the one estimate route, flagged
   `authoritative:false`. Evidence: trace-era §3.
6. **One root-mass forever; conductors become a lane family when N>1.** The
   mass is the REPO (main branch, landings), not the conductor — that is
   already what `RootMass` models. When >1 conductor identity is detected,
   render conductor lanes distinctly instead of folding them silently.
   Evidence: §3 display analysis.
7. **Detection before display: add `selectConductors` (distinct conductor
   `(lane, sessionId)` identities in-window) + a provenance-strip voice
   ("2 conductors seen") + widen the `conductor-not-instrumented` gap to
   per-conductor.** No new events needed. Evidence: §3 detection.
8. **Default-lane collision is a bug to close: `rhizomorph env conductor`
   twice should not merge two orchestrators into one row.** Either the env
   command warns when the receiver has already seen that lane string under a
   different sessionId this session, or conductor lanes are auto-suffixed the
   way `--extra-sessions` already does. Evidence: §3 trap.
9. **`telemetry.refused` gets its home in state + a gap voice** (the fold
   drops it today, `reduce.ts:97` — the "#62" home never landed). A refused
   exporter is a second-orchestrator/second-instrument tell and currently
   invisible in the UI. Evidence: §3 detection point 4.
10. **Before any multi-instance story: a boot-time liveness guard on session
    resume.** Two instances on one repo currently share one session file and
    one instance id (§3 adjacent case) — a lockfile/PID probe (or refusing
    to resume a file whose mtime is seconds old) is prerequisite to
    everything federated. Evidence: `session-log.ts:217` + `cli/index.ts:165`.
11. **The record/ACTOR layer stays the cross-instrument answer** — two
    instruments never talk live; they exchange records (`mergeRecords` is
    already per-actor-append-only). Multi-orchestrator display (rulings 6-7)
    must read actor-agnostic state so a merged foreign record renders its
    conductors the same way. Evidence: `record/merge.ts`, `record-format.md`.

## Sources

- Repo (read-only, this session): `packages/server/src/collectors/{git,tmux,workmux,sessionlog,otel,judge}/`,
  `packages/server/src/collectors/resilience.ts`, `packages/server/src/api/otel.ts`,
  `packages/server/src/server/collector-loader.ts`, `packages/server/src/cli/{index,doctor}.ts`,
  `packages/server/src/log/session-log.ts`, `packages/core/src/{collector,reduce}.ts`,
  `packages/core/src/selectors/spend.ts`, `packages/core/src/record/{schema,merge}.ts`,
  `packages/web/src/fleet/buildFleet.ts`, `packages/web/src/scene/geometry.ts`.
- Docs: `docs/prd2.md`, `docs/prd11.md`, `docs/telemetry.md`, `docs/record-format.md`,
  `docs/architecture.md`.
- Research: `research/2026-08-03-trace-era-captures.md` (claude 2.1.220 traces,
  codex 0.145.0 OTLP, Langfuse pricing rip).
- External (delegated web research this session): see §2 citations.
