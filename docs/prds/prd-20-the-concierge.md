# prd-20 — the concierge: a one-stop front door

> **Status:** proposed · gated on #234 landing first (ruling 2)

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
- No building codex/pi/OpenClaw adapters — prd-15 ruling 3 owns the adapter
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

## Open questions

- Retarget semantics — rotate-and-reinit in process vs. supervised respawn.
  Needs its spike; open, not ruled.
- Continuity guarantees per harness: `claude --continue` is proven; codex's
  resume story is not. Open until the adapter lands.
- Where cloned repos live by default. Open, not ruled.
- Whether the wizard's first screen should also carry the start command for a
  machine where rhizomorph itself isn't running yet — the distribution
  question, #177-adjacent. Open, not ruled.
