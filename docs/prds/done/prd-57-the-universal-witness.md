# prd-57 — the universal witness: an agent is a process, and a harness may say so itself

> **Outcome:** shipped 2026-09-17. Milestone `prd57` closed with **21 of 21 issues done**, the
> last being #536 — *"the documents describe the instrument that now exists, and prd-57 closes
> out"*.
>
> **The Status line this replaces read "Awaiting the operator's blessing", and was never
> updated.** No blessing is recorded in this document, though the programme was groomed, built
> and landed in full. That is left as a stated gap rather than filled in: a blessing nobody can
> point at is not one this shelving is entitled to invent. Shelved by prd-60's lane, which
> regenerated `.swarm/prd-milestones.txt` and could not land a green suite while a closed
> milestone's PRD sat on the live shelf (prd56 ruling 1).
> **Kind:** specifying. This PRD names surfaces strangers will build without the author in the
> room (a collector, a hand's grant, a new witness on an existing envelope), so it carries
> specification and is long on purpose.
> **Milestone:** `prd57`, opened at filing so `prd-location-law` has a manifest row for this
> document from its first commit (`prd-18` and `prd-28` are permanent gaps and are never filled).
> **Licenses four ADRs**, filed `proposed` beside this document and moved to `accepted` in the
> blessing: **0052** (amends ADR-0001 — the observer reads the operator's own agent processes),
> **0053** (amends ADR-0019 — the fourth hand may enlist a harness), **0054** (amends ADR-0037 —
> the hook is the third witness), **0055** (amends ADR-0036 — the beacon door is per
> installation, and routing is a rule with a law).
> **Followed by prd-58** (the watched machine). This PRD ends with one instrument watching one
> repo, exactly as today. Nothing here changes what is watched — only how it is seen.
> **Re-cuts** prd-15 ruling 5's enrichment ladder (L0–L4) into L0–L2 plus enrichments; prd-15's
> status line gains this number when wave 4 lands.
> **Zero new dependencies.** The allowance is unspent in every wave, and the closeout re-checks it.

## Problem

Rhizomorph was born watching one harness — a git-worktree swarm run in tmux via workmux — and
inherited that harness's shape as its world model. A lane is a worktree with a pane. Alive means
the pane's text changed. Launch means `workmux add`. Telemetry means an env block pasted per lane.

The cost lands on exactly the person the product is for. A developer running agents in a VS Code
terminal, Windows Terminal, a plain shell or a script has no panes to read, so the instrument asks
them to adopt a multiplexer and a lane manager before it will show them anything true. That is a
workflow to install, not a solution to run.

prd-15 proved the observation half without tmux: `collectors/sessionlog/lane-state.ts` derives
working / waiting / frozen / gone from the transcript tail alone — *"No tmux, no workmux, no hooks,
no cooperation from the agent, no terminal of any particular kind, no OS of any particular kind."*
But `doctor` still warns when tmux is absent — its two `checkOptionalTool('tmux', …)` and
`checkOptionalTool('workmux', …)` calls (`cli/doctor.ts:178-179`) reach the `status: 'warn'` return
inside `checkOptionalTool` itself (`:597-604`) — launch still shells to `workmux add`
(`lab/fork.ts:268`), telemetry still means a per-lane paste, and — the sharpest cost — the organ
**withholds its two most important words**.

`lane-state.ts:278-281` returns `null` for `frozen` and `gone`, and `:263-274` gives the reason:
the event vocabulary's only candidate for a stalled lane is `done`, and *"publishing `done` for a
lane whose process died would convert a crash into a success … this organ must not pre-empt it with
the one word it is not allowed to be wrong about."* The instrument is silent in precisely the case
it exists for, because it lacks a word.

The multiplexer was never the truth. It was a proxy for two facts — what agent processes exist, and
whether they are doing anything — and both have sources that do not care how anything was launched.

## Evidence

- **The probe already exists, with its laws written.**
  `packages/server/src/collectors/sessionlog/process-probe.ts` (339 lines) reads `/proc` through
  `readdir`, `readlink`, `readFile` and nothing else. `process-probe.test.ts` states its laws:
  read-only with no signal idiom (`:405-412`), argv-plus-cwd identity (`:72`), unknown is never
  death (`:219-257`), other users invisible (`:202`), and a declared reason per unbuilt platform
  (`:259-320`). Linux and WSL2 are verified — WSL2 because it *is* `linux` to Node (`:278`), not by
  a second arm. macOS (`ps -axo pid=,command=` + `lsof -a -p <pid> -d cwd -Fn`) and Windows
  (`Get-CimInstance Win32_Process`) are **named strategies, deliberately unbuilt** (`:51-68`).
- **Two of the probe's own laws convict the first draft's plan**, which is why ruling 2 changed.
  `:405-412` forbids `spawn`, `execFile`, `child_process`, `exec(` **in that one file** — so the
  macOS and Windows strategies, which are subprocesses, cannot live there. `:414-418` pins its
  `node:fs/promises` import to exactly `readFile`, `readdir`, `readlink` — so a probe that
  delegated its reading elsewhere would redden its own law. The directory-wide law at `:467`
  forbids only filesystem *writes*, never a subprocess.
- **The harness seam has the members this PRD extends.**
  `concierge/harness/types.ts` defines `HarnessAdapter` with `id`, `displayName`, `implementation`,
  `detect`, `envRecipe`, `launchArgv`, `continueArgv`, `resumeArgv`. `claude.ts:112-128`'s
  `envRecipe` already renders the eleven telemetry variables (`cli/telemetry-env.ts:71-83`).
  ADR-0010 forbids ranking, enforced by `harness-law.test.ts:54-80`, whose forbidden field-name
  list includes **`tier`** — which is why ruling 8 uses prd-15's `L0`–`L2` vocabulary instead.
- **The witness vocabulary exists and is two-valued.** `core/src/events/workmux.ts:27` —
  `AGENT_STATUS_SOURCES = ['workmux', 'sessionlog']`; `events.test.ts:159-166` refuses every other
  literal, including `'beacon'` and `'otel'`. ADR-0037 gave `AgentState` a `witness` field and
  preserved an overruled word as `dissent` (`core/src/state.ts:221, 236, 238`).
- **ADR-0037's refusal of `'beacon'` does not reach a hook.** Its option D lost because *"a beacon
  is a declaration by the harness and the organ's reading is an inference by the instrument"*
  (`ADR-0037:76-79`). A Claude Code hook **is** a declaration by the harness. The refusal was about
  the organ, not about hooks — so ADR-0054 argues `'hook'` on its own merits and records that the
  earlier refusal was narrower than it reads.
- **Hooks are the fact channel.** Claude Code fires `SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`,
  `PreCompact` as JSON on stdin carrying `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
  `Notification` fires on a permission prompt. **Nothing in this repo parses any of it today** —
  `git grep hook_event_name` and `git grep transcript_path` each return zero. The beacon payload
  (`core/src/events/beacon.ts:21-29`) admits `writer`, `kind`, `lane`, `detail?`, `digest`, `file`,
  `offset` and none of the join keys. So ruling 3's keys are a wave-1 schema change of the same
  weight as the `process.*` family, not a fold over an existing shape.
- **The repo's closure idiom is strip-and-never-open, not `.strict()`.** `.strict()` appears
  nowhere in `packages/`. `events/tmux.test.ts:20-43` asserts a fixed key set, a negative list, and
  at `:32` *strips* a legacy key rather than failing the line — because ADR-0011 makes a refusing
  schema the wrong shape for a log that must fold old recordings. `no-open-payload-law.test.ts`
  sweeps `events/*.ts` by glob and forbids `.passthrough(`, `.loose(`, `.catchall(`, `z.record(`,
  `z.any(`, `z.unknown(`. It will pick up `process.ts` automatically, with no fence entry.
- **`Actor` and `Ladder` are taken in `packages/core`.** `record/schema.ts:25-30` exports an
  `Actor` (*who recorded this*), reachable only by deep path. `fleet/types.ts:292` exports a
  `Ladder` (the attention ladder) **through the package root**, so a second one there is a compile
  error.
- **`canonicalize` cannot run in core.** `server/src/paths/containment.ts:99` imports `node:fs`,
  and ADR-0003 keeps `node:*` out of `packages/core`. Hence ruling 3's canonical-at-the-collector.
- **Three things the first draft scoped as work are already true.** Branch is already the primary
  lane label (`core/src/fleet/buildFleet.ts:179` — `draft.label = view.branch ?? view.name`), palette
  is computed from activity and never assigned from a manifest (`web/src/scene/palette.ts:19`), and
  `concierge/launch.ts` shells to no workmux at all (`:505` — the exec seam is *"used for `tmux` and
  nothing else"*). The entire workmux dependency in launch is `lab/fork.ts:268`.
- **`npx rhizomorph` does not exist.** `README.md:28-29` — *"There's no published package … cloning
  the repo is the install story."* Publishing is prd-34's thread, *"still gated on #177, which stays
  the leads'"* (`prd-15:170-171`). Every criterion here is therefore written against `npm start`.
- **The operator's bar**, stated 2026-09-14: *simple to use, easy and clear observability, as
  system/workflow agnostic as possible, plug-and-play — a total newbie or junior could spin up an
  instance and use it.* And: *one complete product that ships with all dependencies. Not a project
  in its own right to install.*

## Success

1. **Zero-multiplexer start.** On a machine with no tmux installed, with two Claude Code sessions
   running in two plain terminals inside two worktrees of one repo, `npm start` shows both lanes,
   correctly placed, each with a liveness state and its witness, within sixty seconds of boot.
   **Not met while** any lane's appearance depends on a pane, a `.workmux.yaml` or a manifest; or
   while `doctor` emits `warn` or `FAIL` naming tmux or workmux.
2. **The process witness keeps four laws and gains a fifth.** A planted `claude -p "<marker>"` in
   argv puts the marker in no event, no record, no API response and no surface. No signal idiom
   exists anywhere in `collectors/process/`. No event names a process whose argv does not match a
   signature. **Not met while** the marker crosses, a signal idiom exists, or any event names a
   non-signature process.
3. **The probe is untouched and still green.** `process-probe.ts` and `process-probe.test.ts`
   carry **no edit** in any wave of this PRD. **Not met while** either file appears in any wave's
   fence.
4. **Enlist once, reversibly.** After one explicit act, every *subsequent* Claude Code session on
   the machine — any terminal, any repo — emits telemetry to the inbox and fires hooks into the
   beacon door, with no per-lane env paste. `unenlist` restores the harness's user-level config
   byte-identically except the keys enlist declared. The diff is shown before the write; the file
   is backed up beside itself. **Not met while** any key outside the declared set changes, while
   enlist is reachable from a collector, a poll or a boot, or while a pre-existing foreign OTEL
   endpoint is overwritten rather than refused by name.
5. **The instrument stops being silent about a dead agent.** With the process witness present, a
   lane whose agent process vanishes without a `SessionEnd` reaches `crashed`, publishes it, and
   the flatline detector sees it. **Not met while** `crashed` can be reached from silence alone, or
   while a stalled-but-alive lane publishes anything other than its inference word.
6. **Declared state exists, and inferred state says so.** With an enlisted harness, a captured
   recording shows `working`, `tool-running`, `waiting-permission`, `idle` and `stopped`, each
   carrying witness `hook`. Without enlist, the same lane renders its inference carrying witness
   `sessionlog` or `process`, and no surface gives an inferred state the affordance of a declared
   one — no summons badge, no alarm colour, no "needs you" copy from inference alone. **Not met
   while** a surface shows an inferred word without its witness.
7. **tmux is an enrichment.** With tmux present, pane titles enrich lane names and pane activity
   appears as a witness. With tmux absent, nothing on any surface says anything is missing. **Not
   met while** the two configurations differ in any way other than the enrichment.
8. **Launch needs no workmux.** A lab fork creates its branch and worktree through the lab's own
   plumbing inside `refs/rhizomorph/` and launches through the harness adapter. **Not met while**
   any launch path requires workmux, or while the lab's or the concierge's namespace law weakens by
   one clause.
9. **Three platforms witnessed.** Each platform leg of the process collector has a real capture
   committed as a fixture under a `CAPTURE.md`, and a verification pass citing the artifact behind
   it. **Not met while** any leg is verified from documentation alone, or while the collector is on
   `main` with a leg unverified and not declared null-only for that platform.
10. **The newbie acceptance runs.** A person who has never used tmux, with Claude Code installed,
    runs one command in a repo and, without reading past the first screen, sees their agents within
    sixty seconds and enlists in one click. Performed by someone who is not the author, recorded
    with what they said. **Not met while** any step required a document or a multiplexer.
11. **Words true in the same commit.** README's Trust section, `SECURITY.md`, `docs/vision.md` and
    `docs/architecture.md` change in the commit that makes their current sentence false — never
    before, never after.
12. **Nothing crosses into territory this PRD disclaims.** `packages/team/`,
    `docs/record-format.md` and `packages/core/src/wire/protocol.ts` carry no edit. **Not met
    while** any appears in any wave's fence. (Note: `core/src/wire/reserialize.test.ts` **is**
    touched — it is a hand-enumerated event list, registered at `.swarm/coupling.txt:135`, and it
    reddens for every new event family. The criterion is about the protocol, not the directory.)

## Non-goals

- **The watched machine.** One instrument, one repo, exactly as today. Colony discovery, N
  recorders and the repo selector are **prd-58**.
- **MCP in either direction.** Both are their own PRDs and neither is required here.
- **The remote harness relay.** Processes inside a container are invisible to the host's table and
  stay so.
- **A terminal in the dashboard.** No PTY, no ConPTY. prd-20 ruling 7's spike stays parked.
- **Enlisting codex, pi or openclaw beyond a declared-not-implemented member.** Each lands behind
  its own capture. Detection of them works today and keeps working.
- **A general process monitor.** The witness matches known agent signatures and nothing else. It
  never lists, counts or names any other process.
- **Signalling any process.** Not signal 0, not `kill`. The witness looks; it never knocks.
- **Reading argv beyond the signature match, or any environment variable of any process.**
- **Ranking harnesses.** ADR-0010 stands; no adapter gains a field anything could sort on.
- **A words plane.** Hook payloads may carry `message` (a permission prompt's short text) truncated
  to a declared ceiling. Never `tool_input`, never prompt or completion text.

## Rulings

### Ruling 1 — a lane is a place, an actor is a process, and the process table is the universal witness

An agent is a process; the OS process table sees every one regardless of how it was launched. A
**lane** is a *place* — a worktree, keyed as `Lane.id` already is (`fleet/types.ts:53-55`: branch
when known, else worktree path, else handle). An **actor** is a *process* in a place: pid,
signature dialect, start time, placement, CPU and RSS deltas, and parentage **among actors only**.

`Lane` gains a collection of actors. **The type is not called `Actor`** — that name is taken in
`core/src/record/schema.ts:25-30` for *who recorded this*. The name is chosen at grooming; this
ruling requires only that it does not collide and that the record's `Actor` is left alone.

**Four witnesses, and only four:** process (discovery, placement, liveness, lifecycle), git
(structure), transcript (content, cost, cwd, session id), telemetry (OTLP and hooks — declared
facts). tmux and workmux are **enrichments**: present, they add pane titles and pane activity;
absent, no surface says so. **A missing pane is never a missing lane.**

Licensed by **ADR-0052**, which amends ADR-0001: the observer's scope widens from the watched repo
to the operator's own agent processes, and its restrictions gain one clause — *it never signals a
process*.

### Ruling 2 — the process collector is its own module; the probe is untouched

`packages/server/src/collectors/process/` is a new collector governed by **ADR-0004's exec seam**
(a pure fold over command output behind an injected `Exec`, the idiom `concierge/launch.ts:505`
already uses for tmux). It reads `/proc` directly on Linux and, on macOS and Windows, through the
named base-system tools — which is why it cannot be the probe: `process-probe.test.ts:405-412`
forbids that file a subprocess, and `:414-418` pins its filesystem imports to exactly three names.

**`process-probe.ts` and `process-probe.test.ts` carry no edit in this PRD** (Success 3). The two
modules share an implementation on Linux only, by the collector reading `/proc` the same way; that
duplication is deliberate and cheaper than amending a law written to be hard to amend. The probe
keeps serving `lane-state.ts`'s stall check exactly as it does today.

**ADR-0004's seam is what makes the unbuilt legs testable at all**, and that is the argument for it
rather than mere convention. Its Decision Outcome states the payoff in the collector's own words:
collectors are pure functions over captured text, `Exec` is injected, *"That is what lets collector
tests run against captured fixtures with no git, tmux or workmux present."* Applied here: a macOS
leg's tests run on Linux against committed `ps`/`lsof` output, and a Windows leg's against committed
`Get-CimInstance` output, on a machine that has neither — which is the only way ruling 10's
three-platform witness is reachable at all now that Actions is retired.

**One constraint the collector inherits and this PRD must not trip.**
`server/collector-wrap-boundary.test.ts` derives its set by walking the barrels — `:330` proves a
sixth collector is picked up automatically, so **no edit there** — but `:206` and `:216` require
every raw factory to be referenced, outside its own definition, barrel and tests, **only inside
`collector-loader.ts`**. The process collector is constructed there and nowhere else.

Three event families, payloads closed **the repo's way** — a fixed key set asserted in the sibling
test, unknown keys stripped on parse per ADR-0011, and `no-open-payload-law` picking the file up by
glob. **Not `.strict()`**, which appears nowhere in this repo and would rot old recordings:

- `process.seen` — pid, dialect, startedAt, worktreePath (canonical; see ruling 3) or null with a
  stated placement, parentPid when the parent is itself a matched actor else null.
- `process.activity` — per tick, per actor, only on change: cpuMsDelta, rssBytes.
- `process.gone` — the pid is absent, or present with a different start time (a recycled pid is
  `gone` then a new `seen`).

**The signature set.** `AGENT_COMMANDS = ['claude','codex','pi']` is a literal in the probe
(`process-probe.ts:106`), and the roster's `command` field exists only on the *not-implemented*
entries with two of three values `null` — so "derive it from the roster" is not a set that exists,
and `harness-roster.ts:134-135` shows the roster citing the probe rather than the reverse. This
ruling keeps them separate: the collector owns its signature list, and a law asserts every entry is
a roster id. Unifying them is a later argument and needs the implemented adapters to declare an
executable name they do not currently declare.

**Platform legs.** Linux and WSL2 ship in wave 2. macOS and Windows each land only behind a real
capture committed under a `CAPTURE.md` (`AGENTS.md:399-412`). Until then each yields no events and
`doctor` says so with the capture command as the remedy. **On Windows, cwd is not exposed for
another process without native calls** — the leg states that, and Windows placement comes from
transcript cwd and hook beacons.

The tick budget line joins `docs/design-notes/collector-tick-budget.md`. Note the note's own
vocabulary is a *subprocess* ceiling; the Linux leg spawns none and its cost is syscall fan-out —
that shape has to be invented, not borrowed.

### Ruling 3 — paths are canonical at the collector; the join is declared or inferred, and every surface renders which

`canonicalize` (`server/src/paths/containment.ts:99`) imports `node:fs` and ADR-0003 keeps it out
of `packages/core`. Therefore **every path leaves a collector already canonical**, stated in the
schema's comment and held by a server-side law asserting the emitted `worktreePath` equals its own
canonicalisation. Core compares values; it never normalises them.

Two join mechanisms, and the actor carries which:

- **Declared** — a hook beacon carries `session_id`, `transcript_path`, `cwd` and the firing
  process's pid. One line joins process ↔ session ↔ transcript ↔ worktree.
- **Inferred** — no hook: process and transcript joined by equal canonical `cwd` and start-time
  proximity within a declared window, chosen from measurement.

**Rendering law:** an inferred join or inferred status never takes the affordance of a declared one.
The disclosure card states the join kind in its why line. `fleet/` and `disclosure/` each carry a
test that mutates the witness and watches the affordance change.

### Ruling 4 — the fourth hand may enlist a harness's user-level configuration

*Enlist* / *unenlist*. (`instrument` is taken — `contract/src/instrument.contract.test.ts:42,149`
pins it for the concierge relaunch.)

ADR-0019 clause 1's two powers gain a third: **(c) enlist or unenlist a detected harness's
user-level configuration**, idempotently and reversibly. Licensed by **ADR-0053**. The bound, each
clause a law that lands before the module:

- **Explicit, per harness, from a human act.** `POST /api/concierge/enlist` is `gated-mutation`
  with its `ROUTE_CLASSES` row; `rhizomorph enlist <harness>` is its CLI twin. No collector, poll or
  boot reaches either.
- **The CLI reaches the hand through the route, not by import.**
  `concierge/namespace-law.test.ts:137` declares exactly one importer — `api/concierge.ts` — and a
  declared importer is a terminus, so everything above it inherits the grant. A `cli/enlist.ts`
  importing `concierge/enlist.ts` directly is a new chain and a violation. `harness-roster.ts`
  exists because `cli/doctor.ts` hit this exact wall and the repo's answer was to move the data out,
  not widen the fence. **This PRD declares no widening of `ALLOWED_IMPORTERS`.**
- **Diff first, then write; backup beside.** The first act returns the exact diff and writes
  nothing. The second writes, after copying the original to `<file>.rhizomorph-backup-<iso>`. The
  file is re-read immediately before writing and the write refuses if it changed since the diff.
- **Exact declared keys.** For claude: `~/.claude/settings.json` → `env` gains what `envRecipe`
  already produces; `hooks` gains one entry per lifecycle event invoking the runner. A law asserts,
  against a fixture with unrelated content, that enlist changes exactly the declared keys and
  unenlist restores the file byte-for-byte except those.
- **Merge, never clobber.** Existing `hooks` entries and `env` variables survive. **A pre-existing
  foreign `OTEL_EXPORTER_OTLP_ENDPOINT` is refused by name** — the operator already exports
  somewhere — and the response offers hooks-only enlist, which still delivers ruling 5. The refusal
  is an event.
- **No secret, no clock.** ADR-0019 clauses 3 and 5 hold as written: a loopback URL and an
  installation id, never a token. (Note for groomers: ADR-0019's own **clause 4** is *"never inside
  the watched repo"*; the shell ban that ten code comments cite as "clause 4" is the *law's* fourth
  clause, named correctly at `ADR-0019:203-206`. Cite the right one.)
- Codex, pi and openclaw get members that throw with the reason *"no capture"*.

**Three subcommands cost three edits each.** `cli-surface-law.test.ts:51-73` pins a literal
`KNOWN_SURFACE` of eleven names and asserts it twice, independently. `enlist`, `unenlist` and `hook`
each need the dispatch table, the README CLI reference **and** `KNOWN_SURFACE`. The surface goes
11 → 14. That file is not in `.swarm/coupling.txt`, so nothing will warn about the third edit.

### Ruling 5 — the hook is the third witness, and `gone` finally has somewhere to land

Licensed by **ADR-0054**, which amends ADR-0037's source union to
`'workmux' | 'sessionlog' | 'hook'`. It argues `'hook'` **on its own merits** and records that
ADR-0037's refusal of `'beacon'` was about the organ's inference, not about a harness's own
declaration — every clause of that refusal is about the organ and none of it reaches a hook.

**Precedence:** hook declaration > workmux roster declaration > transcript inference, with prd-27
ruling 4's asymmetry preserved and every overruled word kept as `dissent`.

**The event vocabulary widens from three words to seven.** The wire enum today is
`['working','waiting','done']` (`events/workmux.ts:6`) — *not* the four words the organ derives
internally, which are a different set (`working/waiting/frozen/gone`, `lane-state.ts:20-25`). It
gains:

| word | meaning | reached when |
|---|---|---|
| `tool-running` | inside a tool call | `PreToolUse` without its `PostToolUse` |
| `waiting-permission` | **needs you** | `Notification` carrying a permission request; withdrawn by the matching `PostToolUse` or `Stop` |
| `stopped` | the session ended on purpose | `SessionEnd` |
| `crashed` | gone without saying so | `process.gone` after `process.seen` with **no `SessionEnd` between** — only from this pair, never from silence |

**And a dead agent stops being silent.** `lane-state.ts:278-281` withholds `frozen` and `gone`
because *"the union's only candidate is `done`, and `done` is a claim of completion that silences
the flatline detector outright."* `crashed` removes that constraint. From this ruling:

- **`crashed` is raised by a tick raiser reading the fold, not by the organ.** The condition —
  `process.gone` after `process.seen` with no `SessionEnd` between — spans three event streams, and
  no collector is ever handed the folded state that holds them. **ADR-0038 already ruled this exact
  shape**: `server/summons.ts` exports a pure `diffSummons(previous, current, now)`, and
  `poll-loop.ts` is its only caller — at the end of `runTick()`, after every collector has polled,
  it reads `recorder.foldSoFar()`, folds through `buildFleet` and edge-triggers. The crash raiser is
  that pattern a second time, in its own module beside it, and is never a collector *"since the
  collector contract never hands folded state."*
- **The organ is therefore unchanged in behaviour.** `frozen` and `gone` both continue to publish
  nothing from `lane-state.ts`; `frozen` stays an inference about a live process, rendered under
  ruling 3. What changes is only `lane-state.ts:263-274`'s **comment**, which today explains a
  constraint that a different layer now resolves, and is rewritten in the same commit to say so.
  No line of that file's logic moves.

Old recordings fold to the same meaning they always had — the literals are additive and the
reducer's existing arms are unchanged (ADR-0011).

> **Grooming note (2026-09-15, filed with this document).** The draft of this ruling said
> *"`lane-state.ts` publishes `gone` as `crashed`"*. It cannot: the organ's third input is the
> **probe's** `boolean | null` (`lane-state.ts:15-16`), while `process.gone` is the **collector's**
> event, and nothing hands one module both. The ruling's decision is untouched — `crashed` exists,
> and only from that pair, never from silence — but its placement was wrong, and ADR-0038's raiser
> is where the repo already puts a judgement that needs the fold. Corrected in place before filing,
> on the operator's word, 2026-09-15. The correction is strictly in Success 3's favour: it moves
> wave 4 further from `process-probe.ts` rather than nearer.

### Ruling 6 — the hook runner is a shipped subcommand writing one line to a per-installation door

`rhizomorph hook` reads the hook's JSON from stdin, adds the firing process's parent pid and a
monotonic sequence, and appends **one line** to the beacon door. It is invoked by the hook entries
enlist writes, each as the **absolute path to the installed CLI resolved at enlist time** — never
`npx`, whose cold start would eat the harness's hook timeout. On Windows that path is the `.cmd`
shim. Its law: exactly one line, to exactly one file, **exit 0 on every failure** — a hook that
fails must never block the agent.

**The door is per installation**, licensed by **ADR-0055**, which amends ADR-0036. ADR-0036 chose
`<dataRoot>/<repoSlug>/beacons/`, and its reason is the one that has to be answered rather than
waved past: a beacon from one repo's swarm must never fold into another repo's session, and the pi
collector *"learned that scoping the hard way … and had to enforce it by header"*
(`ADR-0036:44-50`). ADR-0055 keeps that guarantee and moves where it is enforced, because a per-repo
door requires the *writer* to know the slug derivation the *reader* uses, and a hook may fire for a
repo the instrument has not discovered. The guarantee becomes a **routing rule with a law**: every
line carries `cwd`; the collector routes it to a session by containment; a line matching no watched
repo is retained and attributed to none; and a law plants two repos' lines in one door and asserts
neither folds into the other's session.

**That is not a novel mechanism — it is the one the pi collector already proved, in this tree.**
`collectors/pi/collector.ts:48-69` says it does *not* assume a slug convention it cannot back, and
attributes *"each session by the `cwd` its own header line reports"*, skipping out-of-scope sessions
at `:181` (landed `a51b0867`). So ADR-0036's own cautionary example is, in its current form, a
working implementation of routing-by-`cwd` rather than scoping-by-directory. ADR-0055 adopts it for
the door instead of inventing something.

**A citation constraint for whoever writes ADR-0055.** ADR-0036 records its reason as a bare
prior-tracker issue number, and `.citation-prior-tracker` says of that number, in its own header,
that it *"is a real defect in ADR-0036 by this repo's own rule — ADR-0032 rules that anything
pre-recreation is cited by SHA"*, grandfathered only because that file belongs to prd-27. **ADR-0055
must answer the substance and cite the code and the SHA, never the number** — a new record adding a
row to that grandfathering list would be laundering a fresh violation through a list that exists to
record old ones. (`docs/prds/` is excluded from both the path-citation sweep and the citation-ceiling
law — `doc-citation-law.test.ts:494` — so this PRD may reference the number in prose; `docs/adr/` is
not excluded, and an ADR may not.)

**The runner owns the `mkdir`.** ADR-0036:53-55 — *"The collector never creates the directory …
the writer that appends is the one that knows the directory has to exist."* That makes the runner a
rhizomorph process writing outside the watched repo, invoked by the harness rather than by a hand.
ADR-0055 names it: the runner writes only into the installation's own data root, only ever appends,
and is covered by the enlist grant that installed it.

**The planted-key guarantee moves to the runner.** ADR-0036:57-69 — extra keys are *"ignored and
covered by the digest"*, and *"the file keeps whatever the writer said."* So an unknown key is
stripped from the event and **kept on disk**. A law that a `tool_input` "dies at the boundary" would
be false. The real law is about what the runner **writes**: it emits a declared key set and drops
everything else before the line is formed, with a fixture planting `tool_input` and asserting it is
absent from the written bytes.

### Ruling 7 — the inbox attributes by a stable installation id

Today the inbox keys on `ctx.recorder.sessionId` (`api/otel.ts:96`) — minted per session, *"carried
across a restart by the resumed run (#58)"*, so it rotates on a fresh boot but not on a resumed one.
(The decision is `api/otel.ts:14`'s prd2 wave B / #60; prd-23 ruling 6 keeps the attribution but
argues a different point. Cite #60.)

A user-level configuration written once has no session at all. An **installation id** is minted once
into the data root, is what enlist writes, and is what the inbox checks — same refusal logic, same
throttled `telemetry.refused`, same all-or-nothing body rule (`api/otel.ts:260-262`). The recorder's
session id is unchanged and remains the record's identity. It is a numeric epoch
(`api/meta.ts:266`), so the installation id is not interchangeable with it and should not look like
it. `rhizomorph env <lane>` emits the installation id from this ruling onward.

### Ruling 8 — three levels, named with the vocabulary that already exists

prd-15 ruling 5 named five rungs: L0 zero-cooperation, L1 env, L2 beacon, L3 PTY, L4 tmux/workmux.
This PRD **re-cuts** them — it does not add a second ladder, and it does not use the word *tier*,
which `harness-law.test.ts:57` bans as a field name in `concierge/harness/`:

- **L0 — git + process.** Any repo, zero config. Structure and actors.
- **L1 — + transcripts.** Discovered per dialect, automatically. Content, cost, inferred joins.
- **L2 — + enlist.** One act. Declared state, exact joins, per-lane spend, traces.

L3 (PTY) stays refused. L4 (tmux/workmux) becomes *enrichment*, named nowhere in onboarding.
`doctor` and `/connect` say which level a machine is at and the one command to climb. Neither ever
names tmux or workmux as missing; present, each appears as an `ok` enrichment line.
`--extra-sessions` is retired in favour of per-dialect discovery. prd-15's status line records the
re-cut; the rung vocabulary stays live because ADR-0037:77 cites it.

**Launch** keeps its three arms — tmux window if a server exists, detached, copyable command — and
gains headless through the adapter's argv for the lab's non-interactive runs. `lab/fork.ts` stops
shelling to `workmux add` and creates its branch and worktree through the lab's own plumbing inside
`refs/rhizomorph/`, which prd-12 ruling 1 always required and `fork.ts:30-36` already worries about.
`concierge/launch.ts` needs no change at all — it touches no workmux today.

### Ruling 9 — words change in the same commit as the code that makes them true

README's Trust section, `SECURITY.md`, `docs/vision.md`, `docs/architecture.md` and
`docs/telemetry.md` each change in the commit that makes their current sentence false. README admits
one claimant per wave; the waves below name which.

### Ruling 10 — the collector merges behind a three-platform witness

Actions is retired (2026-09-12) and `ci-local.sh` is one OS, one Node. The process collector — the
least portable component this repo will have shipped — does not merge until each leg has a
capture and a verification pass **citing its artifact**, which is prd-25 ruling 5's actual form
(*"each row cites the workflow leg or dated note behind it"*). Naming who ran it and on what is this
PRD's own addition, kept because no workflow leg exists to cite. A leg with no witness ships
null-only and says so. **#457 is live and relevant**: `ci-local`'s Test leg cannot go green on
native Windows. Wave 0 decides whether that is fixed, worked around, or accepted as a recorded
partial.

## What already exists (do not rebuild)

`collectors/sessionlog/process-probe.ts` (untouched; the collector re-reads `/proc` independently) ·
`lane-state.ts`'s transcript organ · `concierge/harness/` (`HarnessAdapter`, `claude.ts`,
`detect.ts`, `not-implemented.ts`, `harness-law.test.ts`) · `harness-roster.ts` · ADR-0037's
`witness`/`dissent` and prd-27 ruling 4's asymmetry in `reduce.ts` · `collectors/beacon/` and its
parse path · `api/otel.ts`'s refusal and throttle · `ROUTE_CLASSES`, `route-class-law.test.ts`,
`mutation-guard.ts`, the in-band token · `concierge/namespace-law.test.ts` and the wizard ·
`web/src/replay/mutating-calls-law.test.ts` (nine entries today; enlist is the tenth) ·
`lab/fork.ts`'s ceilings and the `withTimeout` composition note · `paths/containment.ts` ·
`cli/doctor.ts` and `web/src/connect/links.ts` · prd-35's settings registry and its coverage law ·
`no-open-payload-law.test.ts` (picks up `process.ts` by glob — no edit, no fence).

## Sequencing

**Territory.** No wave enters `packages/team/`, `docs/record-format.md`,
`packages/core/src/wire/protocol.ts`, `process-probe.ts` or `process-probe.test.ts`.
**`packages/web/src/scene/` is entered by nothing in this PRD.** `core/src/wire/reserialize.test.ts`
**is** fenced by wave 1 — it is an event-list law, not the protocol. Fences are derived at grooming
and re-linted against live lanes before dispatch.

**Wave 0 — operator acts. Not dispatchable.**
Bless the PRD · file ADRs 0052–0055 and move them to accepted · **macOS and Windows captures** from
named cohort members, each with a hook fired so the parent-pid reading is witnessed and one hook
fire timed end to end · rule the `#457` question (ruling 10) · rule the name for the actor type
(ruling 1) · rule the inferred-join window from measurement (ruling 3) · answer the
`FleetContext.test.tsx` slice-ratchet question, which `.swarm/coupling.txt:137` says is *"a ruling,
not a reconciliation"*.

**Two of those acts have a mechanical order, and getting it wrong reddens a law on the filing
commit.** The `prd57` milestone must exist and `.swarm/prd-milestones.txt` must be regenerated **in
the same commit that puts this document on the shelf**: `prd-location-law.test.ts` convicts any
live-shelf PRD with no manifest row (`:837` `NO_MILESTONE_ALLOWLIST`, `:999`), and the manifest's own
header says to regenerate *"before landing anything that opens or closes a prdNN milestone, and
commit the result in the same change"* (coupling lines 171-173). Filing the four ADRs likewise
reaches **coupling line 143** — an ADR number is claimed at landing, not at drafting — so all four
records and their four index rows land together or the numbers move under them.

**Wave 1 — the keystone. Additive, and not zero-claimant.**
`core/src/events/process.ts` + sibling test with the planted-argv fixture · `eventSourceSchema`
gains `'process'` **with the argued comment every member of that enum carries** ·
`EVENT_SOURCE_BY_TYPE` and `allEventSchemas` rows · `agentStatusSchema` gains four words and
`AGENT_STATUS_SOURCES` gains `'hook'`; `events.test.ts:159-166`'s framing updated for three
witnesses · beacon payload gains the four join keys and the runner's declared set · the actor type
and lane collection in `fleet/types.ts` (name from wave 0) · `buildFleet` derives actors and joins
per ruling 3 · `reduce.ts`/`state.ts` carry the precedence and the new slice · `collectors/process/`
law-test skeleton **before any collector source** · the installation-id module with its mint-once
law · the tick-budget placeholder. **Reddens eight coupling points from directories it never
enters** — lines 53, 134, 135, 136, 137, 138, 144, 171 — including the era snapshots, re-blessed by
each era's `CAPTURE.md` with a diff that is the new slice and nothing else. **No README claimant.**

**Wave 2 — the process witness, Linux/WSL.**
`collectors/process/` reading `/proc`, filtered to the watched repo · static registration in
`collector-loader.ts` (coupling 52) · `doctor` and `/connect` rows, with the count-string laws at
coupling 129–131 · the measured tick cost · macOS and Windows legs **only if wave 0's captures
exist**, each behind its fixture and `CAPTURE.md`. **README claimant: the Trust section's
process-witness paragraph.** Merges under ruling 10.

**Wave 3 — enlist, the runner, and declared state.**
`enlist`/`unenlist` on `HarnessAdapter`; `claude.ts` implements, others throw with a reason ·
`concierge/enlist.ts` with its namespace and exact-keys laws **before the module** ·
`POST /api/concierge/enlist` with its `ROUTE_CLASSES` row and the route-count prose in six files ·
`rhizomorph enlist|unenlist|hook` — three subcommands × three edits each, surface 11 → 14 · the
runner with its one-line and declared-key-set laws · the beacon routing law (two repos, one door,
no fold) · installation-id attribution in the inbox · the foreign-endpoint refusal · the web's tenth
mutating call · the disclosure card's join-kind line. **README claimant: the enlist paragraph and
the CLI reference.**

**Wave 4 — L0/L1/L2, the surfaces, and the crash raiser.**
The wizard collapses to Enlist → Connect · `doctor` drops every tmux/workmux warn for an `ok`
enrichment line · **the crash raiser**: a pure edge-triggering module beside `server/summons.ts`,
called only from `poll-loop.ts`'s `runTick()` after every collector has polled, emitting `crashed`
from the `seen`/`gone`-without-`SessionEnd` pair and from nothing else (ADR-0038's shape) ·
`lane-state.ts`'s `:263-274` comment rewritten to say which layer now resolves what it describes,
**its logic untouched** · `--extra-sessions` retired for per-dialect discovery · prd-15's status
line gains the re-cut · `docs/telemetry.md`'s per-lane instructions become the L2 paragraph.
**README claimant: the front door — install, the three levels, the support matrix.**

**Wave 5 — launch without workmux.**
`lab/fork.ts` creates branch and worktree through the lab's own plumbing and launches through the
adapter, headless where declared · the lab and concierge namespace laws each gain a case proving the
new path writes nothing new · the ceilings note records the headless arm. `concierge/launch.ts`
needs no change. **README claimant: the laboratory's launch sentence.**

**Wave 6 — witness and closeout.**
The three-platform verification recorded citing its artifacts · the soak with the process collector
on · the newbie acceptance performed and recorded · the doc sweep · the closeout appended: each
Success assessed, what the plan got wrong, what was measured versus reasoned. **No new README
claimant.**

## Open questions

- **The actor type's name** (ruling 1). Gates wave 1.
- **The inferred-join window** (ruling 3) — a number from measured start-time skew, not a hope.
- **The hook runner's latency budget** — Node cold start against Claude Code's hook timeout,
  unmeasured on every platform. Wave 0's captures time one fire.
- **Parent-pid reliability from a hook** — whether the runner's parent is the agent or an
  intermediate shell differs by harness and OS. If unreliable anywhere, that platform's join is
  inferred and says so.
- **Whether `waiting-permission` carries the tool name** from the preceding `PreToolUse`. Useful,
  and a tool name is not a tool input — but it is another field on a closed set.
- **Codex's lifecycle channel** — no hook system in Claude Code's sense; whether its `notify` config
  can carry a `Notification`-equivalent is a capture question.

---

## Amendment — `crashed` is a pathology, and one scene file is entered (operator, Lachlan Kelliher, 2026-09-15)

Raised at grooming, before any issue was filed, and ruled in session the same day. **Ruling 5's
decision is unchanged**: `crashed` exists, it is reached only from a `process.gone` following a
`process.seen` with no `SessionEnd` between, and never from silence. What this amendment settles is
where the word lives once the fold has it, which ruling 5 did not say and which decides a fence.

**The gap.** Ruling 5 widens `agentStatusSchema` — the *event* vocabulary. The fleet's *derived*
vocabulary is a different type, `LaneActivity` (`packages/core/src/fleet/types.ts:22`:
`'working' | 'waiting' | 'done' | 'idle' | 'unknown'`). Three of the four new words land on it
cleanly — `tool-running` is `working`, `waiting-permission` is `waiting`, `stopped` is `done`, with
declared-versus-inferred already carried by ADR-0037's `witness` rather than by a separate word.
`crashed` lands on none of them: `done` is the exact "convert a crash into a success" failure the
ruling exists to remove, and `unknown` says less than the instrument knows.

**The ruling.** `crashed` joins `PathologyKind` (`packages/core/src/fleet/pathology.ts:24`), not
`LaneActivity`. Three reasons, in the order they weighed:

1. **A crash is a thing wrong with a lane, which is what a pathology already is.** It takes
   `PATHOLOGY_RANK`'s `broken` rung beside `frozen`, whose own comment calls dead air *"the only
   lane state that is unambiguously broken"* — a crash is that, with a witness.
2. **The machinery already exists and the crash raiser is already on it.** ADR-0038's summons raiser
   reads `Lane.pathologies` from the fold on the tick and edge-triggers; this ruling's raiser is the
   same shape (see the Grooming note under ruling 5), so `crashed` arrives where that raiser already
   looks rather than needing a second path.
3. **`activityOf` already lets a pathology reach activity** —
   `packages/core/src/fleet/plumbing.ts:360` reads `lane.pathologies.some((p) => p.kind ===
   'waiting')` beside `lane.agentStatus`. So a pathology is not a quieter place to put the word; it
   is the place the fleet already consults.

**The territory sentence is corrected, because as written it was unachievable.** Sequencing said
*"`packages/web/src/scene/` is entered by nothing in this PRD."* No route to Success 5 satisfies
that: any new lane-state word — activity or pathology — is keyed exhaustively by a colour table, and
the colour tables live under `scene/`. The correction is the smallest one available:

> **Exactly one file under `packages/web/src/scene/` is entered, by exactly one wave.** Wave 4, the
> crash raiser's wave, claims `packages/web/src/scene/marks/node.ts` — one row in its
> `Record<PathologyKind, Rgb>` and the switch beside it — and nothing else under that directory.
> **`packages/web/src/scene/view/useFrameLoop.ts` and `packages/web/src/scene/tripwire-law.test.ts`
> are entered by nothing, in any wave**, which is the property prd-58's Success 2 actually depends
> on.

That row is `crashed: status.broken` — an existing named rank colour, so **no new hue is minted** and
charter law 9's "colour is computed, never picked" is satisfied by construction. The alternative
considered and rejected was widening `LaneActivity`, which costs three `Record<LaneActivity, …>`
tables in `packages/web/src/scene/palette.ts` — coupling entry 36, read by seven sibling modules —
and a colour the activity map does not already have.

**One sequencing consequence, ruled with it.** Wave 1 widens `agentStatusSchema`'s **words** only.
`AGENT_STATUS_SOURCES` gaining `'hook'`, and ruling 5's precedence, **move to wave 3**, where a hook
can actually emit. Landing a third source literal and a precedence arm in wave 1 would be code whose
only test could not bite — the defect shape `AGENTS.md` names as *"a test that cannot fail for the
reason it claims"* — and it would put `packages/core/src/reduce.ts` in two wave-1 fences at once.
Wave 3 gains the union, the precedence and the law that exercises all three witnesses together.

## Closeout — prd-57 (2026-09-16)

> Written at `prd57-w5-the-launch`, after waves 1–5 landed. Waves 1 and 2 are on
> `main`; waves 3, 4 and 5 are PRs #576, #578 and this branch's. Wave 6's other
> half (#535, the verification record) is assessed below and is **not** written
> by this lane.

Every Success is assessed **met**, **not met** or **not assessed**, with what
decides it. "Not assessed" is used where the criterion asks for a live run this
lane did not perform — it is never a synonym for met.

### The twelve

1. **Zero-multiplexer start — NOT ASSESSED.** Its falsifier's second half is met
   and tested: `doctor` emits no `warn` or `FAIL` naming tmux or workmux, both
   read `ok` present or absent, and the two configurations differ in nothing but
   their own two lines (#531). Its first half — two real sessions in two plain
   terminals, seen within sixty seconds of boot — is a live run on a
   tmux-less machine that nobody has performed. Decided by performing it.

2. **The process witness keeps four laws and gains a fifth — MET.** The planted
   marker is asserted absent from the written bytes rather than from a parsed
   event, which is the stronger form and the one ADR-0036 forces (a collector
   keeps whatever the writer said, so only "never written" is true). No signal
   idiom exists in `collectors/process/`; no event names a non-signature
   process. Measured by test, in wave 2 and again in wave 3's runner.

3. **The probe is untouched and still green — MET.** `process-probe.ts` and
   `process-probe.test.ts` appear in no wave's fence and carry no edit. Checked
   against every prd-57 commit, not assumed.

4. **Enlist once, reversibly — MET, with one unverified platform.** The diff is
   shown before the write and the server holds the digest bar, so a caller that
   skipped the first step is refused rather than trusted; the original is copied
   beside itself, create-only; a pre-existing foreign OTLP endpoint is refused
   **by name** with what is still on the table. Enlist is reachable only through
   `api/concierge.ts`, which two namespace laws hold. **The gap:** on Windows a
   global npm install puts a `.cmd` shim on PATH while `argv[1]` is the `.mjs`
   inside the package, so an enlist there may write a hook command that does not
   execute. Declared in `api/concierge.ts` rather than guessed at; the macOS and
   Linux paths are the ones this PRD can stand behind.

5. **The instrument stops being silent about a dead agent — MET.** `crashed`
   rises from a recorded `process.gone` following a `process.seen` with no
   session end between, and **cannot** be reached from silence: the raiser takes
   no clock and no threshold, so it cannot express "quiet for N minutes" at all,
   and a test asserts its arity so a later edit cannot add one. `lane-state.ts`
   keeps every line of its logic, so a stalled-but-alive lane still publishes
   only its inference word.

6. **Declared state exists, and inferred state says so — STILL NOT MET, and
   nearer, by amendment 2026-09-17 (#589, #597).** Read the assessment below
   first: it was written the same day, it is what the milestone closed on, and
   the amendment at the end of this item is what changed. Recorded rather than
   rewritten — a closeout that quietly shows the right verdict teaches nobody
   what it cost to find the wrong one.

   *(assessed at close: NOT MET. Corrected then from "partly met", on evidence
   rather than on reading. This item has now been assessed three times and been
   too generous twice — which is itself the finding.)*

   **A hook firing reaches no lane.** `cli/hook.ts` writes `sessionId`,
   `transcriptPath`, `cwd` and `pid`; `reduce.ts`'s `beaconReceived` joins by
   the line's `lane` label and returns the state unchanged when it is null. The
   hook cannot write a lane — it fires inside the agent's own process and does
   not know what this instrument calls the lane — which is exactly what ruling
   3's DECLARED join exists to solve, and that join was never built. Measured
   end to end through the real `beaconLineFor`, the real `parseBeaconLine` and
   the real `reduceAll`: `lane: null`, `state.declared: {}`.

   So `hook` is admitted, ranked and obeyed by the fold (#529) — and nothing
   emits a hook-sourced `agent.status` and nothing folds a hook beacon. The
   vocabulary is real and inert.

   **This is a fifth instance of the shape named under "what the plan got
   wrong"**, and the most expensive: #529's tests assert the fold obeys the
   ranks WHEN HANDED a hook-sourced event, which is a true statement about a
   function nothing calls. An assertion that the input is well-formed standing
   in for one that something reads it.

   Owed as the declared join itself, not as a card's why line.

   > **Amendment, 2026-09-17 — the join is built; the criterion still does not
   > read MET (#589, and the gap is #597).**
   >
   > **What landed.** A beacon that names no lane is placed by its `pid` against
   > the actor the process witness already found, and lands under that actor's
   > worktree path, which `buildFleet` resolves back to a lane. So the sentence
   > above — *"nothing folds a hook beacon"* — is no longer true of this tree.
   >
   > **The join is a pid lookup and not a `cwd` one, and that was forced rather
   > than preferred.** A containment test needs `isInside`, `isInside` needs
   > `node:fs`, and ADR-0003 keeps that out of `packages/core`. A prefix compare
   > in its place is a defect this repo has already fixed twice by name. So a
   > line whose pid matches no actor is **declined rather than guessed at**: a
   > platform with no process leg sees no declared attention instead of a wrong
   > one, which is ADR-0010's answer, not a shortfall hidden inside a met
   > criterion.
   >
   > **The card's why line landed with it**, which is the half #532 recorded as
   > owed. `DeclaredAttention.joinedBy` records which key carried the
   > declaration, `joinVoice` spells it from one place, and both surfaces —
   > `diagnose.ts`'s waiting evidence and `condition.ts`'s declaration clause —
   > import it, so prd-27's *"the condition is assembled once"* stays true
   > instead of becoming a comment above two spellings. Neither join is ranked:
   > both are declared, and ADR-0010 asks for the gap named, not scored.
   >
   > **What does NOT hold, and why this is not MET.** The NOT MET text above has
   > two clauses. The amendment answers the second. **The first is still true
   > today**: *"nothing emits a hook-sourced `agent.status`"*.
   >
   > `cli/hook.ts` maps five hook events to four distinct words, and
   > `BEACON_ATTENTION_KINDS` holds **two** of them — so `PostToolUse`, `Stop`
   > and `SessionEnd` now reach the fold as `working` or `stopped`, and
   > `PreToolUse`'s `tool-running` and **`Notification`'s `waiting-permission`
   > reach nothing at all.** Those two belong to the `agent.status` vocabulary,
   > `AGENT_STATUS_SOURCES` has named `'hook'` as its third source since #529,
   > and the only two emitters are `sessionlog` and `workmux`.
   >
   > So the most valuable hook of the five — the harness saying it has stopped
   > for a human — is written correctly, parsed correctly, and then **discarded
   > before the join is reached**: `beaconReceived` runs `isAttentionKind`
   > before `placeByPid`, so that line is never joined to anything. (An earlier
   > draft of this amendment said "joined to its lane correctly, and discarded",
   > which overstated what landed; corrected in review.)
   >
   > And the `waiting` this criterion reads on is the third declared word — one
   > **the hook never writes**. Ruling 5's precedence arms remain what this
   > closeout already called them: a true statement about a function nothing
   > calls.
   >
   > **How it was found, which is the part worth keeping.** By the end-to-end
   > test the review of #589 said was missing — nothing in the repo ran
   > `beaconLineFor` into `parseBeaconLine` into `reduceAll` into `buildFleet`.
   > The first thing that ever did, failed on its first run. Three assessments
   > of this criterion were made by reading modules; the one measurement that
   > ran the writer against the reader found the defect immediately, twice
   > (#589, then #597). That is the whole lesson of this item, and it did not
   > take until the third assessment to be available — only to be performed.
   >
   > The gap is pinned by a test that asserts today's behaviour and will redden
   > when #597 lands (`cli/hook.test.ts`, *"GAP (#597): a Notification firing
   > reaches no lane"*), because what let this survive three waves was that
   > nothing reddened.
   >
   > **Also still owed, and not this criterion's**: the affordance test #532's
   > DoD pairs with the why line. It is a test over a field that now exists,
   > where before it was a test over one that did not.

7. **tmux is an enrichment — MET.** Absent and present both read `ok`; the whole
   doctor report is diffed between the two configurations and only the rig's own
   two lines differ. `connect/links.ts` no longer paints an absent rig `broken`.

8. **Launch needs no workmux — MET, at ruling 7's floor.** `workmux add` is not
   spawned and nothing outside the lab's namespaces is created: the arm's
   worktree is the laboratory's own, detached, with no ref outside
   `refs/rhizomorph/`. **No arm is started**, and that is a finding rather than
   a shortfall — `claude -p` runs a whole turn to completion where `workmux add`
   returned at once, so spawning one per arm would serialise the experiment
   inside a ceiling a real turn exceeds and spend the operator's money
   synchronously. Every arm takes prd-20 ruling 7's floor: restored, ready,
   handed its command. A detached spawn is owed and is its own decision
   (ADR-0048's argument re-made for a process nobody is watching). Both namespace
   laws gained a case and neither weakened by a clause — the lab's asserts the
   launch argv creates nothing and the module spawns no workmux, the
   concierge's asserts the laboratory reaches no adapter.

9. **Three platforms witnessed — NOT ASSESSED by this lane, and #535 owns it.**
   The macOS leg was run by the cohort and reviewed; Linux is this PRD's
   authoritative gate and every wave ran on it; Windows cannot go green locally
   (#457) and its legs were attributed by failing test NAME against a
   same-worktree baseline rather than by a green run. Whether that clears the
   criterion is #535's call to record, with the artifacts.

10. **The newbie acceptance runs — NOT MET.** No person who is not the author
    has run this. It is not simulated and a described walkthrough is not a
    performance of it, so it is reported not met rather than assessed. #535
    records it when someone runs it.

11. **Words true in the same commit — MET.** README's Trust section moved in the
    commit that made ADR-0019's "exactly two powers" false (#525); the front
    door and `docs/telemetry.md` moved in the commit that retired the flag their
    rows named (#533); `SECURITY.md`, `docs/vision.md` and `docs/architecture.md`
    move here, in the wave that made their sentences false.

12. **Nothing crosses into territory this PRD disclaims — MET, checked.**
    All 51 commits carrying a prd-57 issue number were diffed against
    `packages/team/`, `docs/record-format.md` and
    `packages/core/src/wire/protocol.ts`. None touches any of them. Stated
    having checked rather than assumed, which is what the criterion asks for.

**Zero new dependencies — HOLDS, re-checked rather than repeated.** Every
`package.json` in the PRD's commit span was diffed for an added dependency line.
There are none. One export entry was added to `packages/server/package.json`
(`./log/installation-id`), which is a path this repo already publishes from, not
a dependency.

### What the plan got wrong

- **The `crashed` fan-out was under-counted.** `crashed` joining `PathologyKind`
  breaks four exhaustive `Record`s, which the compiler names, and one plain
  **array** — `scene/geometry/layout.ts`'s `PATHOLOGY_PRIORITY` — which it does
  not. A kind missing from that array compiles and silently renders no label at
  all. It was in no fence. The plan's fence for #530 named `marks/node.ts` and
  stopped.

- **#532's fence could not express #532's DoD.** It named six UI files; the
  retired flag's parser was in `cli/args.ts`. Recorded on the issue.

- **A `PathologyKind` that `diagnose` can never emit was not anticipated.**
  `crashed` turns on a recorded edge in the fold rather than on a `Lane`'s
  shape, which made a standing law — every kind appears in the staged fixture —
  unsatisfiable by construction. `DIAGNOSED_KINDS` names the distinction now.

- **Ruling 8's re-cut needed a second vocabulary, not a renaming.** The plan
  says the rungs keep their names; it did not say that `doctor` and `/api/meta`
  would then answer in two vocabularies and stop agreeing. A law asserted they
  agreed. It now asserts they map.

- **The headless launch could not be built as planned, and only building it
  showed why.** The difference between `workmux add` and `claude -p` is
  fire-and-forget versus run-to-completion, which no reading of either surfaced
  — the suite HANGING is what surfaced it. Ruling 8's launch half lands at its
  own fallback rather than its main clause.

- **The third witness was built and never connected, and the closeout said
  "partly met" until someone ran it.** Wave 1's amendment moved `hook` out of
  that wave precisely because *"a third source literal with no emitter is a
  literal whose precedence arm no test could exercise"* — and wave 3 built the
  emitter's WRITER while nothing was taught to read what it writes. The
  amendment's own reasoning was right and the wave it moved to did half of it.
  *(The join landed by amendment on 2026-09-17 as #589. Building it did NOT make
  the criterion met: the first end-to-end test from writer to reader then found
  a second, independent break — the hook writes two words the fold's vocabulary
  does not hold, #597. See Success 6. The lesson is not retired with either fix:
  what caught both was running the writer against the reader, and three waves of
  green tests had never done that.)*

- **Retiring a flag broke three tests on Linux that Windows could not show.**
  One of them was the end-to-end wiring test for the flag itself — a known
  drive-letter timeout on Windows, so its real failure sat underneath an
  unrelated one. This is the same name-level masking that made Linux the
  authoritative leg for this PRD after wave 2, and it recurred at the last wave.

### Measured versus reasoned

**Measured.** Every law in this PRD that claims to bite was run against a
deliberately broken tree: the three-speaker fold in all six permutations; the
inbox's key (20 red across six routes, both arms); the wizard's arming bar; the
hook's stdin bound (red *after hanging five seconds*); the refusal's exit code.
The territory and dependency checks above are commands, not recollections. Every
wave gated on Linux with `origin/main` an ancestor.

**Reasoned.** The Windows enlist shim (Success 4's gap) — nobody has run an
enlist on Windows, and the failure mode is argued from `argv[1]`'s shape rather
than observed. The headless arm's 120s ceiling — inherited from a process that
ran `npm ci`, kept because #408's ruling rather than its premise still applies,
and fitted to nothing anyone has measured. Both are stated where they live.
