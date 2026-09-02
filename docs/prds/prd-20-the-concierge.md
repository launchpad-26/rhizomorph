# prd-20 — the concierge: a one-stop front door

> **Outcome:** re-cut 2026-08-24, **groomed 2026-09-02** — the fourth-hand fence, capability
> gate, harness registry, local discovery, clone, launch/relaunch, transcript migration and
> setup wizard ship, and the retarget engine ships gated and tested. Of the amendment's two
> remaining outcomes, **ruling 7's is already satisfied by the tree** (see the grooming note
> below); the other is #216 — the wizard invoking the route prd-42 hardened. One issue is the
> whole of what is left. Reconciled 2026-08-22 at `03df141`; regroomed at `26c48c7`.

## Problem

Getting from a fresh machine to "an instrumented conductor watching my repo"
requires a chain of shell incantations that must run in exactly the right
process — clone, build, start, generate the env block, eval it in the shell
that will exec the agent, relaunch the agent. Each step is a place to fail
silently, and the person paying is a cohort member who just wants to point the
instrument at their repo and their CLI and go. prd-19 makes the failure honest;
it still hands the user a command line. The remaining gap is that setup itself
is homework.

## Evidence

- **Operator report (Gabe, 2026-08-07):** even a project lead running the
  instrument ended up with an uninstrumented conductor. The wiring is homework
  today, and the homework gets skipped.
- **The physics** (docs/telemetry.md): instrumentation attaches at launch, not
  retroactively. No page can wire a running CLI — but a conductor can be
  *relaunched with continuity* (`claude --continue`) inside a wired envelope.
  The dream is achievable; silent retro-attachment is not.
- The `.workmux.yaml` SCAR: the same-process env requirement has already failed
  invisibly once, proven only by reading `/proc/<pid>/environ`. A convention
  (`scripts/lane-agent.sh`) exists; a guarantee does not.
- `docs/vision.md`: *"Type `rhizomorph` in any repo running a worktree swarm
  and get a radar screen at localhost."* prd-9 ruling 1: a total junior,
  running within a minute, no author in the room.

- **The wave-8 live proof (2026-08-14, #521; conductor-run against the wave-7
  tree serving on :4321).** A real unwired Windows one-shot session
  (`544321a7…`, marker `RHIZO-PROOF-84117`) was enumerated by the fold with
  its place fields, previewed verbatim by `GET /api/session-preview/…`, and
  instrumented through the token-gated route the CLI's own scrape pattern:
  `POST /api/concierge/launch {mode:'resume'}` answered 200 with the proven
  continuity plan, `migration: {kind:'migrated'}` landed the 23,100-byte
  transcript in the watched repo's slug dir **cross-host**, and the Windows
  source hashed byte-identical before and after (create-only held live). The
  migrated copy then resumed wired with one `-p` turn and answered the marker;
  otel rose 14→18 booked under the **preserved** sessionId, and the
  uninstrumented row **cleared itself** — ruling 6's whole story, witnessed
  end to end.
- **The proof's real finding (#532):** the endpoint's detached no-TTY spawn
  (#264's design, tested only with injected spawns) dies immediately —
  `claude --resume` without a prompt or TTY errors with *"Provide a prompt to
  continue the conversation"* — so `{kind:'launched', pid}` is reported and
  nothing survives, in every mode. The copyable command (ruling 3's no-trust
  path) is unaffected. Filed with captures and candidate directions.

## Success

A stranger with node, git, and a supported agent CLI on a fresh machine reaches
an instrumented conductor watching their chosen repo in under five minutes,
without composing a shell command beyond the documented start. Choosing a repo,
choosing a conductor CLI, launching or relaunching it instrumented, and
verifying flow are each a single explicit click, and the verification is
prd-19's — facts, not hope. **Not met while** #234 is open, or while any
concierge route accepts a request without the capability token.

## Non-goals

- **No OAuth, no accounts, no stored credentials.** Clone-by-URL uses the
  machine's existing git/gh credentials; "no auth, no cloud, no accounts"
  stands. (Operator-decided 2026-08-07.)
- **No simultaneous multi-repo.** One repo, one rhizomorph — switching
  retargets, never multiplies.
- No npm publish — prd-15's last wave, still gated on #177.
- No building codex/pi/OpenClaw adapters — prd-15 ruling 4 owns the adapter
  contract; the picker lists them honestly as not-yet-implemented.
- No autostart of anything not explicitly clicked; never a write inside the
  watched repo's working tree.

## Rulings

## Ruling 1 — the fourth hand: the concierge

The concierge may (a) launch or relaunch a conductor process and (b) clone a
repo to disk — each power token-gated, each invoked only by an explicit human
act in the UI, never from a collector or a poll, each carrying its own law
test. The read-only constitution is AMENDED, not dissolved — prd-12's exact
clause, and the amendment gets its ADR (the log is append-only). Requires a
proper adversarial review before merge; this hand touches process execution.

## Ruling 2 — hardening is the gate

No concierge route ships before #234's capability-token guard covers every
mutating route, including the new ones. #234 is already Ready on the board;
this PRD makes it load-bearing rather than parallel.

## Ruling 3 — launch honesty

The shop never claims to attach to a running process. It detects the
uninstrumented conductor (prd-19's fact), says so plainly, and offers relaunch
with continuity — naming what continuity means per harness and what is lost.

## Ruling 4 — the harness registry is built for N, claude first-class

A `HarnessAdapter` seam — detect, env recipe, launch argv, continue argv —
with claude implemented end-to-end now, codex next (its native OTel config was
verified in research), and every other harness listed in the picker as
declared-not-implemented, capabilities-honesty style. The picker's dropdown is
the UI of prd-15's adapter contract, not a rival to it. (Operator-decided
2026-08-07.)

## Ruling 5 — repos: discover locally, clone by URL, retarget in place

The repo picker discovers local repos — including enumerating
`~/.claude/projects`, the repos the user's Claude already knows — and offers
clone-by-URL through the machine's own credentials. Switching the watched repo
rotates the session and retargets the collectors; it never spawns a second
instance.

## Ruling 6 — the migration power: one create-only copy, and the UI says what it costs

Ruling 3 promises relaunch *with continuity*, and for the operator whose
conversation happened somewhere else — another checkout, another machine — the
instrument could not keep that promise: `claude --resume` looks only in the
slug directory of the cwd it is launched in. So the fourth hand gains one
further write, and **only** one.

It may COPY a session transcript from a place already declared to this
instrument — a location `candidateTranscriptPaths` derives from the event log's
own attribution — into the harness state directory for the watched repo,
`~/.claude/projects/<watched-repo-slug>/`. **Create-only:** it never
overwrites, never deletes, never edits a line, and never writes anywhere else
under `~/.claude`. It is invoked only by the same explicit human act that
requests the resume — never a collector, never a poll, never a timer. **The
original file is never touched and the original process is never stopped, and
the UI says both, every time.**

To ruling 3's bar — what continuity means, and what is lost:

- **Means:** the conversation history resumes in the new, instrumented process
  under the **same sessionId**. The resume appends to the copied file in place;
  it does not fork it and does not mint a new id, and telemetry from the
  relaunched process books under that same preserved id. Transcript filename,
  in-file `sessionId` and event log agree.
- **Lost:** everything the old process already did. Telemetry never back-fills,
  so every token, dollar and tool call spent before the relaunch is outside
  this instrument's record permanently.
- **Also lost, and the part that is easiest not to say:** the old process keeps
  running on its own host until the operator ends it. Anything typed there
  after the copy belongs to a **fork** — one this instrument can see only
  through its transcript tail, never through telemetry, and which nothing in
  either file marks as divergent.

**Evidence:** `research/2026-08-14-cross-host-resume.md` (#513) — four
questions, four GO, with raw output reproduced: the copy-and-resume works
same-host and cross-host (a Windows-authored transcript resumed on Linux, `cwd`
fields untouched), the resume appends in place preserving the sessionId, and
OTLP books under that preserved id. Size and dead paths in tool results are
settled too, by the note's own Q2b: a 23 MB / 6133-line Windows transcript, 1294
tool-use blocks and 542 absolute Windows paths across its tool results, resumed
cleanly with full context and left the source byte-identical.

One caveat travels with the ruling and is not a footnote: it is verified on
Claude Code **`2.1.232`**, whose session-log format is explicitly free to change
between releases. Two narrower limits stay open and are named rather than
implied — a transcript past ~24 MB, and one whose dead Windows paths the
*resumed* agent is asked to act on rather than summarize.

The amendment is on the record as
[ADR-0020](../adr/0020-transcript-migration-is-a-create-only-copy.md), and the
fence lands before the copy does: `assertMigrationPaths`
(`server/src/concierge/paths.ts`) derives both paths rather than validating a
supplied one, and clause 6 of the concierge's namespace law runs it against
real directories and pins `COPYFILE_EXCL` as an obligation on the wave that
writes the copy.

## Sequencing (waves, each gated as ever)

0. **#234** (exists, Ready) — the token guard, extended to all mutating routes.
1. The amendment: ruling + ADR + namespace/law scaffolding for
   `server/src/concierge/`.
2. Parallel: harness registry + detection · clone-by-URL · local repo
   discovery (good first issue).
3. The launch route (relaunch-with-continuity path included) · the retarget
   design spike, then retarget itself — the heaviest server change, spike
   first.
4. The setup wizard on `/connect`: repo → conductor → verify (reusing prd-19's
   handshake rows) → done.
5. The migration ruling and its fence — ruling 6, [ADR-0020], and
   `assertMigrationPaths` + namespace-law clause 6, landing ahead of the copy
   the same way wave 1 landed ahead of the hand (#514). Gated on the
   cross-host resume spike (#513), which is what made the ruling writable.
6. The migration itself: the `COPYFILE_EXCL` copy behind the token gate, and
   the relaunch-with-continuity UI that names the fork and the lost telemetry.

[ADR-0020]: ../adr/0020-transcript-migration-is-a-create-only-copy.md

## Open questions

- Continuity guarantees per harness: `claude --continue` is proven; codex's
  resume story is not. Open until the adapter lands.
- Where cloned repos live by default. Open, not ruled.
- Whether the wizard's first screen should also carry the start command for a
  machine where rhizomorph itself isn't running yet — the distribution
  question, #177-adjacent. Open, not ruled.

## Amendment — the re-cut: two outcomes and a narrowed promise (operator, 2026-08-24)

Ruled on the retained-PRDs review's recommendation, against the tree at `9a26030`.

The sequencing list above is history, not a backlog: waves 0–6 shipped, #234 included — the
Success falsifier naming it is discharged — and wave 3's "retarget design spike" describes a
route that now exists, gated and proven (`api/retarget.ts`, `retarget.test.ts`,
`retarget-law.test.ts`, `server/retarget-cost.test.ts`). The rotate-vs-respawn open question
is deleted above rather than left to imply doubt: ruling 5 already ruled it — the switch
rotates the session and retargets the collectors — and the implemented route does exactly
that. What remains of this PRD is two outcomes:

1. **The wizard calls the route.** `connect/wizard.tsx` still tells the operator that
   switching the watched repo "is not built" and withholds the path for an unwatched repo.
   The remaining build is the wizard invoking `POST /api/retarget`, showing its consequences
   — the recording boundary, the telemetry cost the route already reports — and continuing
   the same setup journey in the newly watched repo.
2. **The no-tmux launch tells the truth** — narrowed by ruling 7.

### Ruling 7 — the no-tmux launch promise narrows; a real terminal is a parked option

Where tmux exists, launch stays one explicit click into a real window. Where it does not,
the product presents the copyable command — ruling 3's no-trust path, which #532's finding
left untouched — and says plainly why: a detached interactive CLI has no terminal to live
in, and `claude --resume` without a TTY dies asking for a prompt. The Success clause's
"launching … a single explicit click" is narrowed by this ruling to the tmux path. A real
no-tmux terminal (a PTY; ConPTY on Windows — the option prd-15's L3 rung named and prd-25's
open question points at) is **parked here as a named technical option behind its own
spike**; no wave claims it until that spike is blessed.

## Grooming note — ruling 7 is satisfied; one outcome remains (2026-09-02, #222)

Groomed against `main` at `26c48c7`.

**Ruling 7 — DISCHARGED by the tree.** It narrows the no-tmux launch promise: where tmux
exists, launch stays one explicit click into a real window; where it does not, the product
presents the copyable command and says plainly why. `packages/web/src/connect/wizard.tsx`'s
`LaunchResult` already renders exactly that, as its own answer rather than compressed into a
generic success:

> started detached (pid {pid}) — there was no tmux window to put it in, so nothing is
> attached to it. An interactive harness with no terminal may exit on its own (#532); watch
> the rows below rather than trusting this line, and run the harness yourself in a terminal
> if nothing arrives.

The component's own doc comment records the defect it was written against — a response that
said `launched` over a process that had already exited — and the four outcomes it refuses to
compress. No issue is minted for ruling 7. The PTY/ConPTY tier stays parked as a named
technical option behind its own spike, exactly as the 2026-08-24 amendment left it.

**Outcome 1 — #216.** The wizard still tells the operator that switching the watched repo
"is not built" and withholds the path for an unwatched repo. That is false twice: ruling 5
ruled it, and `packages/server/src/api/retarget.ts` ships the route gated and tested. No file
under `packages/web/src` calls `POST /api/retarget` today. #216 is the control, its
consequences, and the continued setup journey in the newly watched repo.

The sequencing list above remains history, not a backlog, as the amendment says.
