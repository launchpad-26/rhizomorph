# Agnostic adapters — how observability stacks stay orchestrator-agnostic, and what rhizomorph should adopt vs refuse

> Researched 2026-08-05 for the "full system agnosticism" future: any terminal,
> any orchestrator, any agent CLI. Claims tagged [Ran] / [Verified] /
> [Consensus] / [Thin], per the repo's grading discipline. **This note ran no
> new captures** — [Ran] here always means "the repo's own captures, cited"
> (`research/2026-08-03-trace-era-captures.md`,
> `research/2026-07-30-telemetry-capture-routes.md`); everything web-sourced
> today is at best [Verified] (primary doc read) or [Consensus] (multiple
> independent secondary sources). Repo read via
> `\\wsl.localhost\Ubuntu\home\lachlan\worktrees-challenge` (read-only).

## The question

Rhizomorph is a read-only, localhost-only, event-sourced observer: collectors
→ one append-only JSONL log → one reducer → live+replay UI
(`docs/architecture.md`). Its constitution: never instrument the observed,
never write to the watched system, never send anything anywhere, render
missing signal as an honest gap. How do existing agent-observability stacks
achieve orchestrator-agnosticism, and which of their mechanisms survive that
constitution?

---

## Thread 1 — OpenTelemetry GenAI/agent semantic conventions: state as of today

### Status: still Development, now in its own repo, with a versioning gap

- **[Verified]** The GenAI conventions remain **Development/experimental — no
  stable 1.0** as of July 2026. At semconv **v1.42.0 (12 June 2026)** all
  `gen_ai.*` spans/attributes moved out of the main semantic-conventions repo
  into a dedicated repo, `open-telemetry/semantic-conventions-genai`. That
  move is organizational (its own release cadence), **not** a graduation to
  stable — and the dedicated repo **has no releases or tags yet**, so the
  last versioned cut is v1.42.0 from the core repo. (John Hodge, "The state
  of the OpenTelemetry GenAI semantic conventions", July 2026; GitHub
  `semantic-conventions-genai`; multiple 2026 secondary sources agree.)
  This confirms and extends the repo's own §4 finding from 2026-08-03.
- **[Verified]** Churn is real and recent: `prompt_tokens` →
  `input_tokens` (v1.27.0, 2024), **`gen_ai.system` → `gen_ai.provider.name`
  (v1.37.0, Aug 2025)** — "the most visible split between older framework
  telemetry and the current convention" — evaluation events (v1.38.0), agent
  span shape refinements (v1.41.0, Apr 2026). Hodge's conclusion, worth
  quoting: *"OpenTelemetry-compatible is not yet a sufficient schema contract
  for GenAI telemetry."*

### The agent span schema they define

**[Verified — GitHub `gen-ai-agent-spans.md`, all marked Development]**
Operation names: `create_agent`, `invoke_agent` (as a CLIENT span for remote
agent services, and as an INTERNAL span for in-process frameworks like
LangChain/CrewAI), `invoke_workflow`, `plan`, plus `execute_tool` and `chat`
in the sibling docs. Required attributes on all: `gen_ai.operation.name`,
`gen_ai.provider.name`. Recommended: `gen_ai.request.model`,
`gen_ai.usage.input_tokens`/`output_tokens`, `server.address`. Span naming:
`invoke_agent {gen_ai.agent.name}`. Content capture
(`gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.system_instructions`) is opt-in, metadata-only by default — the same
posture rhizomorph's attribute allowlist already takes. Nothing in the agent
spans addresses CLI/terminal agents specifically.

### What the three CLIs actually emit

- **claude-code** **[Verified — code.claude.com/docs/en/monitoring-usage,
  fetched today; matches repo capture [Ran] §1]**: a **custom
  `claude_code.*` span vocabulary** (`interaction` → `llm_request` /
  `tool` → `tool.blocked_on_user` + `tool.execution`, plus `hook` behind
  `ENABLE_BETA_TRACING_DETAILED`) with a **partial gen_ai sprinkle** — and
  the sprinkle still includes **`gen_ai.system: "anthropic"`, the
  pre-v1.37.0 attribute name**. So the flagship CLI is not conformant with
  the *current* conventions; it emits a frozen partial subset of an older
  generation. Traces remain **beta-gated** (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`
  + `OTEL_TRACES_EXPORTER=otlp`) — no graduation since the 2026-08-03
  capture.
- **codex** **[Ran — repo capture §2]**: an entirely private `codex.*`
  namespace (`codex.exec`, `session_task.turn`, `codex.turn.token_usage`…),
  ~350 internal micro-spans per trivial run, posts all three signals to the
  **bare endpoint path** (no `/v1/<signal>`), no cost metric, no `gen_ai.*`
  observed.
- **gemini-cli** **[Verified — google-gemini/gemini-cli
  `docs/cli/telemetry.md`]**: the closest to the conventions —
  `gen_ai.client.token.usage`, `gen_ai.client.operation.duration` metrics,
  span attributes `gen_ai.operation.name`, `gen_ai.request.model`,
  `gen_ai.tool.name`, `gen_ai.usage.*`, log event
  `gen_ai.client.inference.operation.details`. OTLP gRPC (default) or HTTP,
  default endpoint `http://localhost:4317`, plus a **local file target**
  (`telemetry.outfile`) that bypasses OTLP entirely — a fourth capture route
  rhizomorph hasn't probed. No documented lane/resource-attribute story;
  `OTEL_RESOURCE_ATTRIBUTES` support untested [open question, same as codex].

### What changed since the repo's 2026-08-03 capture (claude 2.1.220)

**[Verified — the docs' own version-gated changelog]** Everything listed in
the current monitoring docs is ≤ v2.1.216, i.e. already inside the captured
2.1.220 — **no new telemetry surface has shipped above the pinned fixture
version**. But the docs name things the capture note didn't inspect, worth
folding into the fixtures on the next capture pass:

- `workflow.run_id` / `workflow.name` on events and spans (v2.1.202+) and
  `parent_agent_id` on tool spans — partially answers the note's open
  question 2 (nested-agent shape) from the docs side; still needs a capture.
- `message.uuid` / `client_request_id` on events (v2.1.214+);
  `OTEL_LOG_TOOL_CONTENT` span events; `OTEL_LOG_RAW_API_BODIES` (inline or
  `file:<dir>`); 60KB content truncation cap
  (`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`).
- **`terminal.type` is a standard attribute on all signals** — a free
  environment-identity hint the parser currently ignores.
- The privacy posture is unchanged and still mandatory to defend against:
  `user.email`, `user.id`, `organization.id` ride every signal by default.

### Verdict for the agnostic channel

**Betting on OTLP-the-protocol is sound; betting on GenAI-semconv-the-schema
is premature — and the strongest evidence is that the CLIs themselves don't
conform.** OTLP/HTTP is a stable 1.x wire protocol; the GenAI conventions
are a Development-status vocabulary that even Anthropic emits an outdated
fragment of, codex ignores entirely, and only gemini-cli approximates. A
receiver that *required* `gen_ai.*` conformance would reject two of the
three CLIs it exists for. The repo's standing stance (§4 of the trace note:
"map `gen_ai.*` where present, never adopt it as storage schema — the
additive envelope stays ours") is exactly right and is also what Hodge
independently recommends ("maintain an internal versioned schema rather than
depending on external Development-status specs"). Re-check when the
dedicated repo cuts its first tagged release — that, not the repo move, is
the signal to build a real `gen_ai.*` mapping profile.

---

## Thread 2 — How agent-observability products ingest agnostically

| Product | Primary mechanism | Cost to an orchestrator they've never heard of |
|---|---|---|
| **Langfuse** | **OTLP-native**: `/api/public/otel(/v1/traces)`, OTLP/HTTP + Basic auth, feeding the same queue/workers/ClickHouse as its SDKs; SDKs are conveniences on top. [Verified — langfuse.com OTel docs; repo [Ran] §3 proved it ingests claude-code's beta spans as-is and auto-classifies them] | Zero *if* the stack already emits OTLP; otherwise someone must add an exporter **inside the app** (a code change). Deliberately "no Langfuse-specific library needed" for OTel-speaking stacks — this is how they got Java/Go/Rust support without building ten SDKs. |
| **LangSmith** | SDK-first (LangChain-native), plus a **full OTLP endpoint** (`api.smith.langchain.com/otel`) since ~March 2026, steered by standard `OTEL_EXPORTER_OTLP_*` env vars. [Verified — langchain.com blog + docs] | Same as Langfuse: unknown-but-OTel-speaking = env vars; unknown-and-mute = instrument it yourself. |
| **AgentOps** | **SDK auto-instrumentation**: `agentops.init()` monkey-patches installed LLM providers/frameworks; OTel underneath; decorators for custom spans. [Verified — docs.agentops.ai core concepts] | Highest: requires being *in the agent's process* in a supported language, before startup. An unknown orchestrator gets nothing until someone writes an instrumentation package for it. |
| **Helicone** | **Proxy** (swap the model base URL; gains caching/rate-limiting because it *is* the gatekeeper) or **async logging SDK** off the critical path. [Verified — docs.helicone.ai proxy-vs-async] | Proxy: one config line — but it sits on the request path (an outage is *your* outage), sees API credentials, and observes only the model call, never the agent's local behaviour. Note: Helicone entered **maintenance mode after acquisition (March 2026)** [Consensus — multiple secondary sources; not verified against a primary announcement]. |
| **Braintrust** | SDK + **OTLP endpoint** (`api.braintrust.dev/otel/v1/traces`), auto-converting LLM spans to its own span types. [Verified — braintrust.dev OTel docs] | Same OTLP story. |

### The pattern to copy

**Every one of these products, whatever it started as, converged on an OTLP
endpoint as the agnostic front door** — accept one wire protocol, then run
per-source *mapping profiles* server-side (Langfuse auto-classifying
`llm_request` → GENERATION is exactly that). Agnosticism is achieved by
standardizing the **transport** and absorbing dialect differences in the
**parser**, never by shipping N client libraries. Rhizomorph already does
this: one `/v1/*` receiver, per-CLI parse profiles with attribute
allowlists, additive events. The generalization is to make "mapping profile"
a first-class, contributor-addable concept (thread 4).

### The anti-patterns to refuse

1. **SDK instrumentation** (AgentOps' whole model, LangSmith's default):
   requires the observed agent's code/process to change. Rhizomorph
   observes; it never instruments the observed. Env vars at launch
   (`rhizomorph env`) are the permitted boundary — configuration the CLI
   already honors, binary untouched.
2. **Proxying the model API** (Helicone's primary): puts the observer on the
   critical path (a crashed observer halts the fleet — the opposite of
   read-only), routes credentials through it, and still can't see local
   behaviour (files, terminal, waiting-on-human). The repo's own LiteLLM
   spike (`2026-07-30` note §S3) already found proxying subscription OAuth
   fragile. Helicone's maintenance-mode fate is circumstantial but
   consistent: the proxy seat is infrastructure, with infrastructure's
   obligations.
3. **Requiring semconv conformance** — see thread 1.
4. **One more thing none of the five can do**: observe an agent with *zero*
   cooperation. All five need the agent stack to either call them, emit to
   them, or route through them. Rhizomorph's filesystem/git/tmux floor
   (thread 3) is a genuine differentiator — there is no industry mechanism
   to copy there, only terminal-world prior art.

---

## Thread 3 — Universal capture floors: what zero cooperation buys

Scored against the four things rhizomorph needs per lane — **identity**
(which lane is this), **liveness** (is it alive), **activity** (is it
working), **needs-attention** (is it blocked on a human) — plus telemetry
(tokens/dollars), portability, and intrusiveness.

### 3a. Filesystem watching — git state and session-file tailing

- **Git watching** (current `git` collector): fully CLI-agnostic — works for
  OpenClaw, a bare zsh, a human. Identity: strong and structural
  (worktree/branch = lane). Activity: strong but **lagging** (commits,
  dirty-file deltas — minutes-scale). Liveness: weak alone (silence ≠
  death). Attention: none. Portability: anywhere git runs, including across
  the WSL/Windows boundary rhizomorph already straddles. Intrusiveness:
  zero. [Ran — the product's shipped baseline]
- **Session-log tailing** (current `sessionlog` collector): the richest
  zero-cooperation source *for CLIs that write one*. Claude Code's
  `~/.claude/projects/<slug>/*.jsonl` carries `sessionId`, `cwd`,
  `gitBranch`, per-message four-tier usage, `model`, `requestId`,
  `isSidechain`, tool calls — "attribution is structural" [Ran — 2026-07-30
  note §S2]. Liveness: strong (append cadence). Activity: strong.
  Attention: weak (inference from last-role + silence at best). Telemetry:
  tokens yes, dollars no. Intrusiveness: zero — but it is a **per-CLI
  dialect**, discovered per-CLI (`--extra-sessions` already exists for
  out-of-tree dirs, `docs/telemetry.md`). Codex is believed to write session
  rollout files under `~/.codex/sessions/` [Thin — from training priors,
  **not captured**; a codex-sessionlog adapter must start with a
  dialect-verification capture]. gemini-cli's `telemetry.outfile` (local
  OTLP-shaped log file) is a documented file-drop equivalent [Verified —
  gemini docs] and would make a *file-tailing* OTel adapter possible with no
  network receiver at all.

### 3b. Process-table inspection

Identity: weak-to-medium (cmdline + cwd; cwd is easy via `/proc/<pid>/cwd`
on Linux, `lsof`/libproc on macOS, genuinely awkward on Windows). Liveness:
strong (pid exists) — **but the repo's own memory says process-aliveness
lies for agent CLIs** (`claude workers die under workmux`: pane can drop to
a bare shell while something looks alive; trust the pane footer, not the
process table). Activity: medium (CPU-time delta as a work proxy — noisy).
Attention: none (a blocked-on-permission claude and a thinking claude look
identical). Portability: three different APIs (procfs / libproc /
Win32+WMI); solved by libraries, but per-OS code. [Consensus] Intrusiveness:
zero. **Verdict: a liveness *corroborator*, never a primary signal.**

### 3c. PTY/terminal recording

- **`script(1)`** — util-linux (Linux) and BSD (macOS) variants; absent on
  Windows. Raw typescript + timing file; no semantic structure. [Consensus]
- **asciinema v3** [Verified — docs.asciinema.org/manual/asciicast/v3]:
  NDJSON — header line then `[interval, code, data]` events; codes include
  `"o"` (output), `"i"` (input), `"r"` (resize), and **`"x"` — the session's
  exit status as the final event**. This is an event-sourced,
  line-delimited, replayable terminal log — *structurally the same shape as
  rhizomorph's own session JSONL*, and the natural interchange format if
  rhizomorph ever grows a PTY-wrapper adapter (tail the .cast live; the
  `x` event is a clean lane-terminal signal that even exit codes from the
  process table can't give you retroactively). CLI 3.0 is Rust;
  Linux/macOS/*BSD — native Windows support not claimed [Thin — not
  verified; Windows runs it under WSL].
- **Windows ConPTY** [Verified — learn.microsoft.com pseudoconsoles]:
  API-level pseudo-console; the recorder must *own the spawn*
  (`CreatePseudoConsole` + drain the output pipe). No `script(1)`
  equivalent ships with Windows; PowerShell `Start-Transcript` records at
  command level, not the VT stream [Consensus]. So on Windows a PTY floor
  means shipping a small wrapper binary — feasible, not free.
- **Signal quality (all three)**: activity strong (the literal output
  stream — this is `pane.activity`'s content-hash delta, without tmux);
  liveness strong; attention **inferable** from output patterns (permission
  prompts, "esc to interrupt" footers — same heuristics workmux uses);
  identity only what the wrapper stamps on it. Intrusiveness: **medium — the
  launch command changes** (`rhizomorph wrap -- claude ...`), the agent's
  code does not. That is the constitution's line: wrapping is configuration
  of *how the operator launches*, not instrumentation of the observed
  binary.

### 3d. Shell-integration escape sequences

- **OSC 133** (FinalTerm "semantic prompt", adopted by iTerm2) [Verified —
  wezterm.org/shell-integration, terminfo.dev/osc, otty docs]: marks
  prompt-start / prompt-end / pre-execution / **command-end with exit
  code**. Emitted by shell rc hooks; consumed by the terminal. Support is
  broad: Ghostty, iTerm2, kitty, WezTerm, VS Code terminal, Windows
  Terminal, foot; tmux consumes but forwarding to the outer terminal is
  still an open request (tmux#5237, #3064) [Verified].
- **OSC 633** (VS Code's superset) [Verified — code.visualstudio.com
  shell-integration docs]: adds `E` (the exact command line, nonce-guarded)
  and property sequences (cwd). Parseable by anything sitting on the PTY
  (there are standalone parsers, e.g. suin/osc633-parser).
- **The catch for rhizomorph**: these mark the **shell's** command
  lifecycle. A long-lived TUI agent (claude interactive mode) is *one
  command* — inside it, no marks, because **agent CLIs don't emit OSC 133
  themselves: claude-code has three open feature requests for it
  (anthropics/claude-code #22528, #26235, #32635), none shipped**
  [Verified]. So today this floor gives: strong start/stop/exit-code
  structure for *one-shot* agent invocations (`claude -p`, `codex exec`) and
  for bare-zsh lanes (a human's terminal becomes a legible lane for free),
  and nothing extra for interactive TUI sessions. And consuming the
  sequences requires being in the byte path — i.e. a PTY wrapper (3c) or
  the tmux collector rhizomorph already has (`capture-pane` sees rendered
  content, though tmux strips/keeps escapes depending on `-e`). If the
  claude-code feature requests land, this floor upgrades sharply for free —
  worth a watch, not a bet.

### The floor→ceiling ladder

| Level | Operator setup | What it yields (identity / liveness / activity / attention / telemetry) |
|---|---|---|
| **0 — nothing** | point rhizomorph at the repo | worktree=lane / process-table corroboration only / commits+dirty deltas (lagging) / **honest gap** / **honest gap** |
| **0.5 — dialect files exist** | none (CLI already writes session logs) | +sessionId/cwd/branch (structural) / append cadence / per-message tools+tokens / weak inference / tokens, no dollars |
| **1 — env vars at launch** | `rhizomorph env <lane>` (or `.workmux.yaml` does it) | +lane/role resource attrs [Ran, claude; untested codex/gemini] / export cadence / llm+tool events / `blocked_on_user` spans (retrospective) / **tokens + dollars** (claude; codex needs pricing table) |
| **2 — PTY wrapper** | launch via wrapper (`script`/asciinema/ConPTY shim) | wrapper-stamped lane / byte-stream + exit event / full output stream / **prompt-pattern heuristics, live** / none |
| **3 — tmux/workmux** | today's full rig | pane+manifest / pane hash delta / capture-pane / `agent.status: waiting` (live, declared) / (via level 1) |

Each level is additive and independently degradable — which is exactly the
existing `collector.disabled` / gap-voice machinery. Nothing on the ladder
requires touching the observed agent's code; levels 1–2 change only how a
lane is *launched*.

---

## Thread 4 — The adapter SPI

### What exists (the base to not break)

- `packages/core/src/collector.ts`: `Collector<Snapshot>` — `name`,
  `initialSnapshot()`, `poll(prev, ctx) → { nextSnapshot, events[] }`, with
  `ctx.emit` the one validated event factory (`createEvent` throws at the
  boundary). Pure logic over captured command output; fixture-tested without
  the real binaries.
- The **push shape** already exists too, un-named: the OTLP receiver is not
  a `Collector` — it's routes + pure parsers (`parseMetricsExport`,
  `parseTracesExport`, `packages/server/src/collectors/otel/`) ending at the
  same event union. So the SPI de facto has two shapes: **polled** (pull a
  substrate, diff a snapshot) and **receiver** (accept a post, parse, emit).
  The generalization should name both rather than force PTY/OTLP adapters
  through a poll loop.
- The event vocabulary is additive by law
  (`packages/core/src/events/index.ts` — one discriminated union,
  `EVENT_SOURCE_BY_TYPE`), and the four per-lane questions are all *derived*
  (`buildFleet`: `ageMs` vs `workAgeMs`, ladder, fences) — collectors stay
  dumb.

### The smallest adapter contract that keeps reducer and UI untouched

An adapter for X (OpenClaw, codex, a bare zsh terminal) **MUST** provide:

1. **A name** and a **presence probe** — substrate missing ⇒ one
   `collector.disabled`, everything else keeps working (existing law).
2. **Lane identity resolution** — map X's native identity (session dir,
   pane, resource attr, wrapper tag) onto a lane handle, or the one stable
   `UNATTRIBUTED_LANE` (never a minted per-restart hash — the
   `attribution.ts` lesson).
3. **Events only from the existing union.** This is the whole trick: if the
   adapter speaks `worktree.*` / `pane.*` / `agent.status` / `llm.usage` /
   `llm.cost` / `tool.activity` / `trace.span`, the reducer, selectors,
   `buildFleet`, and every panel work **unchanged**. A new adapter that
   needs a new event type is a core PR first, adapter second — additive by
   law.
4. **A work/noise declaration per event kind it emits** — which of its
   events refresh `workAgeMs` (real work) vs only `ageMs` (heartbeat/noise).
   This is the ageMs/workAgeMs split surfaced as contract: the prd3 keystone
   bug (a pane repaint keeping WAITING alive forever) is exactly what an
   adapter author will reintroduce if the split stays implicit.
5. **Read-only conduct**: no writes to the observed system, no outbound
   network, no exec of anything mutating — structurally testable the way
   `drawer/readonly.test.ts` already greps its own source.

**SHOULD** (honest gaps when absent, never fabricated): liveness beyond "no
events", activity stream, attention signal, telemetry, transcript source.

**Capability manifest.** Each adapter declares what it *cannot* see, so the
gap voice renders it as absent-on-purpose:

```ts
interface AdapterCapabilities {
  identity: 'structural' | 'declared' | 'none'   // worktree/session-dir vs env-tag vs unattributed
  liveness: boolean
  activity: 'stream' | 'lagging' | 'none'        // pane/PTY vs commits-only
  attention: 'declared' | 'inferred' | 'none'    // agent.status vs prompt-heuristic vs gap
  telemetry: { tokens: boolean; dollars: boolean }
}
```

This mirrors dialect-verification's own ruling that a probed limitation is
"a **capability in config**, not a comment" (its `canRunProjectTooling`
example), and it gives `rhizomorph doctor` and the UI's gap voice one
machine-readable source for "this lane's attention column is empty because
the zsh adapter cannot see attention," which is a different sentence from
"the agent never waits."

### Conformance: captures over docs

Test discipline per `.claude/skills/dialect-verification/SKILL.md` (readable
at `C:\Users\operator\agenticlaunchpad\.claude\skills\dialect-verification\SKILL.md`;
the rhizomorph repo enforces the same discipline in practice —
version-pinned fixture names like
`claude-code-2.1.220-traces-interaction-root.json` and a
`fixture-hygiene-law.test.ts` in the otel collector):

1. **Real captures, both outcomes** — a success fixture *and* an
   absence/failure fixture (missing binary, malformed file, empty session
   dir) captured from the real tool, never hand-written from docs ("a
   hand-written fixture validates your reading, not the tool").
2. **Fixtures pinned to tool versions in the filename**; an upstream rename
   is a fixture update, not a schema migration; unknown names map to a
   stable `other`, never an error (the trace parser's existing rule).
3. **A shared conformance suite** every adapter runs against its own
   fixtures: emits only valid union events (`parseEvent` round-trip); lane
   resolution never mints unstable ids; absence path emits exactly one
   `collector.disabled`; no event fabricated when the fixture carries no
   signal (gap honesty); work/noise declaration covers every emitted type;
   read-only grep. That suite — not review — is what lets a stranger's
   OpenClaw adapter land without anyone re-deriving trust.
4. **Label what remains unverified** in the adapter source (the skill's §6)
   — e.g. codex `OTEL_RESOURCE_ATTRIBUTES` support is still an open
   question in the repo's own notes.

---

## The adapter matrix

Setup (rows) × the five signals; each cell: **how / the gap**.

| Setup | Identity | Liveness | Activity | Attention | Telemetry |
|---|---|---|---|---|---|
| **Bare repo, unknown agent** (level 0) | worktree/branch = lane (structural) | commits+dirty cadence; process table corroborates / *slow, minutes-lagging* | diffstat, dirty-file set / *no in-flight view* | **gap, said aloud** | **gap** |
| **+ CLI session files** (claude today; codex [Thin, needs capture]; gemini `outfile` [Verified, unbuilt]) | sessionId+cwd+gitBranch, structural / *per-CLI dialect to verify* | file-append cadence | per-message tools+usage timeline | weak inference (last role + silence) / *never "declared"* | four-tier tokens / *no dollars* |
| **+ env vars at launch** (`rhizomorph env`, level 1 — OTLP) | lane/role resource attrs [Ran, claude] / *codex+gemini honoring untested* | export cadence | `llm_request`/`tool` spans, metrics | `tool.blocked_on_user` spans / *retrospective only — spans export on end* | tokens **and dollars** (claude) / *codex: tokens only, pricing-table estimate flagged `est.`* |
| **+ PTY wrapper** (level 2 — script/asciinema/ConPTY shim; also the only door for OpenClaw/bare-zsh attention) | wrapper-stamped lane tag | byte stream + asciicast `x` exit event | full output stream (hash delta without tmux) | **prompt-pattern heuristics, live** / *heuristic, per-CLI patterns, must be capture-derived* | **gap** |
| **+ shell integration** (OSC 133/633 host shells) | cwd via OSC 633 P / *shell-level only* | command start/end marks | per-command boundaries + exit codes | prompt-open = shell idle / *blind inside TUI agents; agent CLIs emit none today (claude-code #22528 open)* | **gap** |
| **+ tmux** | pane→worktree mapping | pane presence | capture-pane content-hash delta | footer/prompt heuristics | **gap** |
| **+ full workmux** (level 3) | lane manifest (handle/branch/fence) | workmux status | agent.status transitions | **declared** `agent.status: waiting` — the only non-heuristic live attention | (via level 1) |

Reading the matrix column-wise gives the honest headline per signal:
**identity** is solvable at every level (git is the universal floor);
**activity** is solvable at every level above 0; **live attention** is the
scarce signal — only declared status (workmux) or PTY-level heuristics
provide it, and OTLP never will while spans export on end; **dollars** exist
only where the CLI computes them (claude) — everything else is a flagged
estimate or a gap.

## Recommended adapter contract (sketch)

```ts
// packages/core — additive beside Collector<S>; existing collectors unchanged.
interface AdapterProfile {
  name: string                       // 'sessionlog-codex', 'pty-wrap', 'otel-gemini'
  shape: 'polled' | 'receiver'       // poll loop vs POST/tail route
  capabilities: AdapterCapabilities  // the honest-gap manifest above
  /** Event types this adapter may emit — conformance-checked against fixtures. */
  emits: EventType[]
  /** Which of those refresh workAgeMs (work) vs only ageMs (heartbeat). */
  workSignals: EventType[]
  resolveLane(native: NativeIdentity): string /* | UNATTRIBUTED_LANE */
}
// polled ⇒ implements Collector<S> as today;
// receiver ⇒ pure parse(body|chunk) → RhizomorphEvent[] behind a server route.
```

Definition of done for "the X adapter": success + absence fixtures captured
from real X (versions in filenames); shared conformance suite green; zero
diffs outside `packages/server/src/collectors/<x>/` (+ optional core PR if —
and only if — the union genuinely lacks a needed fact); capabilities
manifest wired to doctor + gap voice.

## Adopt / Refuse

**Adopt:** OTLP receiver as the one cooperative front door (the whole
industry converged there) — transport, not schema; per-source mapping
profiles with attribute allowlists and name allowlists (the Langfuse
auto-classification pattern, already proven against rhizomorph's own spans);
env-var-at-launch as the instrumentation ceiling; PTY wrapping (asciicast v3
as the interchange shape) as the universal attention/activity floor for
CLIs with no telemetry at all; capability manifests + capture-pinned
conformance suites for contributor adapters.

**Refuse:** SDK instrumentation of the observed agent (AgentOps' model —
violates "observes, never instruments"); model-API proxying (critical-path,
credential-bearing, not read-only; Helicone's trajectory is the cautionary
tale); `gen_ai.*` as storage schema or a conformance requirement (Development
status; even claude-code emits the outdated generation); minted fallback
identities (hash-of-session lanes); fabricated signal where a capability is
absent (the gap voice is the feature); outbound forwarding (standing prd9
ruling 9).

## Sources

Repo (read-only, `\\wsl.localhost\Ubuntu\home\lachlan\worktrees-challenge`):
`docs/architecture.md`; `docs/telemetry.md`;
`research/2026-08-03-trace-era-captures.md`;
`research/2026-07-30-telemetry-capture-routes.md`;
`packages/core/src/collector.ts`; `packages/core/src/events/index.ts`;
`packages/server/src/collectors/otel/{index,attribution}.ts` + fixtures.
Skill: `C:\Users\operator\agenticlaunchpad\.claude\skills\dialect-verification\SKILL.md`.

Web (accessed 2026-08-05):

- https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/ (July 2026 state)
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- https://opentelemetry.io/blog/2026/genai-observability/
- https://code.claude.com/docs/en/monitoring-usage (claude-code telemetry, version changelog)
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md
- https://langfuse.com/integrations/native/opentelemetry · https://langfuse.com/faq/all/existing-otel-setup
- https://docs.langchain.com/langsmith/trace-with-opentelemetry · https://www.langchain.com/blog/opentelemetry-langsmith
- https://docs.agentops.ai/v2/concepts/core-concepts
- https://docs.helicone.ai/references/proxy-vs-async (+ maintenance-mode reports: vevee.org, chatforest.com, futureagi.com — secondary)
- https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry
- https://docs.asciinema.org/manual/asciicast/v3/
- https://code.visualstudio.com/docs/terminal/shell-integration (OSC 633)
- https://wezterm.org/shell-integration.html · https://terminfo.dev/osc · https://docs.otty.sh/vt/osc/osc-133
- https://learn.microsoft.com/en-us/windows/console/pseudoconsoles (ConPTY)
- https://github.com/anthropics/claude-code/issues/22528 · /26235 · /32635 (OSC 133 requests, open)
- https://github.com/tmux/tmux/issues/5237 · /3064 (OSC 133 forwarding, open)
