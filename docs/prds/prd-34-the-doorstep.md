# prd-34 — the doorstep: from npx to software

> **Status:** proposed · **Kind: specifying** (`docs/prds/README.md`) — stage 1 of the staged ship, deliberately outside the metamorphosis:
> zero constitutional change, packaging only. Sources:
> `docs/research/2026-08-13-from-localhost-to-true-software.md` (lands with PR #432) and
> `docs/metamorphosis/system-design.md` (PR #462). Completes prd-15's delivery thread — npm
> publish, gated on #177 — rather than competing with it. The design charter (PR #451) governs
> any chrome the shell adds. Milestone 20. Citations verified at origin/main `e8fed56`.

## Problem

The instrument is real software that ships like a dev server. A stranger meets it as a terminal
command, an npm build and a `127.0.0.1` tab they must keep alive by hand — and the research
spike's central finding is that "localhost is unprofessional" is two separable complaints the
industry solved independently. Network reach is the metamorphosis's problem, ruled elsewhere
and later. Delivery form is this PRD's: Docker Desktop, Ollama, JupyterLab Desktop and LM
Studio all converted a localhost dev-server into software with zero change to network posture —
signed installer, background daemon decoupled from any window, tray icon, auto-update,
first-run wizard. Nobody fixed the ugly URL with a prettier URL; they hid it inside an app
window. Until rhizomorph does the same, every first impression spends the operator's
credibility explaining why real software looks like a curl demo.

## Evidence

All from the committed research spike and the system-design doc; source grades as recorded
there.

- **The desktop-shell table stakes, convergent across the school:** signed installer · daemon
  decoupled from any window · tray · auto-update on by default · localhost-default with a
  warned toggle.
- **JupyterLab Desktop is the literal blueprint:** the shell spawns the server and embeds a
  window at `127.0.0.1:port/?token=…`. Electron ships Node in-process, so the existing Fastify
  server and React SPA run unmodified.
- **Token-on-loopback is table stakes, and rhizomorph already has it:** Jupyter's 2016 drive-by
  RCE made it so; the shell consumes the same in-band handshake the browser does (ADR-0012) and
  adds no credential machinery.
- **The real signing costs, stated:** Azure Trusted Signing ~$120/yr (EV no longer buys
  SmartScreen bypass since 2024) and Apple Developer $99/yr (mandatory for macOS auto-update).
- **The doorstep surfaces already exist:** prd-20's concierge, and clone-by-URL merged with
  #452 — the first-run wizard consumes `/connect` and the concierge; it rebuilds neither.
- **prd-15's thread is live:** the 2026-08-03 "no npm publish" ruling and #177's history
  decision still gate publish. This PRD is that thread's completion — software a stranger can
  hold — not a rival channel.

## Success

1. A stranger goes from one command to watching their own repo in under N minutes on Windows,
   without reading AGENTS.md. **Not met while** the path requires hand-editing an env block,
   keeping a terminal open, or knowing what a worktree is before the fleet renders.
2. Closing the window does not kill the fleet. **Not met while** the daemon dies with the last
   window, or quitting is anything but an explicit act from the tray.
3. Updates arrive signed, on by default. **Not met while** an update means re-downloading an
   installer by hand, or an unsigned binary greets SmartScreen or Gatekeeper.
4. The server and SPA ship unmodified. **Not met while** the shell carries a forked copy of
   either package, or a shell-only code path grows inside `packages/server` or `packages/web`.

## Non-goals

- **Not the metamorphosis.** No network exposure, no identity, no sharing — those are stages
  2–4, parked under their own milestone with their own PRDs. The shell is the natural later
  home for the metamorphosis door's `share` toggle, and that toggle is **named here, not
  built**.
- **Not a delivery replacement.** The clone-first path and the npm/npx story stay; the app is
  an addition for the doorstep, and prd-15's publish gate (#177) is untouched.
- **Not a redesign of any surface.** The wizard folds existing doorstep surfaces; the charter
  governs its chrome; no new panels, no new hues.

**Rejected alternatives.** *Tauri* — smaller binaries, but the server must compile into a
per-target sidecar (the official guide still leans on the deprecated `pkg`) and Linux tray
support is weaker; Electron ships Node in-process so server and SPA run unmodified. The choice
is recorded as reversible — both shells share the same architecture. *Containerizing the
watcher* — the local instrument observes the machine: `~/.claude/projects`, the repo,
worktrees, tmux, the git binary. A container wall between the watcher and what it watches is
bind-mount sprawl for negative value; the Docker-wrapped neighbours are services you send data
to, and rhizomorph-local is an observer of your filesystem — a different species. *A prettier
URL* — nobody in the studied school fixed the URL; they hid it inside an app window, and so
does this.

## What already exists (do not rebuild)

The entire instrument: the Fastify server, the SPA, the collector, the CLI (`env`, `doctor`,
`connect`), the concierge with clone-by-URL (#452), and the in-band token handshake (prd-23,
ADR-0012). The shell adds packaging around all of it — spawn, window, tray, updater, wizard —
and rebuilds none of it. JupyterLab Desktop's architecture is adopted, not re-derived; the
research spike already did the comparative work and its grades stand.

## Rulings

Each is a **proposed** verdict with its reasoning; no operator has ruled on any of them.

## Ruling 1 — Electron, on the JupyterLab Desktop blueprint; the server and SPA ship unmodified

The shell spawns the existing server as a child process and embeds a window at
`127.0.0.1:port/?token=…` — the same in-band handshake, the same loopback posture, zero
constitutional change. Electron over Tauri for the reason above: Node rides in-process, so
nothing is compiled into a sidecar and nothing forks.

## Ruling 2 — the daemon decouples from the window: tray, close-to-tray, run-on-login

LM Studio's model. The fleet is a background fact with a window, not a window with a process:
closing the window leaves the watcher running and the tray lit; quitting is explicit, from the
tray; run-on-login is offered, not imposed. This is the table-stakes row the whole school
converged on, adopted whole.

## Ruling 3 — updates are signed and on by default, and the costs are stated, not discovered

`electron-updater` with signed installers on every platform: Azure Trusted Signing ~$120/yr for
Windows, Apple Developer $99/yr for macOS — real recurring costs, stated in the PRD so the
decision to ship the app is made with them on the table, not found at release week. Auto-update
defaults on (the school's convergent stake), with the standard quiet download and
apply-on-restart shape.

## Ruling 4 — the first-run wizard folds the doorstep; it invents nothing

The wizard walks a stranger from launch to a watched repo by driving the surfaces that already
exist — `/connect` and the concierge, including clone-by-URL (#452, prd-20 ruling 5). prd-20
remains the authority on what the concierge may do (launch or relaunch a conductor, clone by
URL; no OAuth, no accounts, no stored credentials). If a seam needs a small affordance to be
wizard-drivable, that change lands as an ordinary web PR under the ordinary laws — the shell
never grows a private fork of a surface.

## Ruling 5 — the first thing a stranger sees is the instrument working, not a form

First launch opens **the demonstration fleet** — the twenty-lane simulation that already exists
for testing — loudly labelled as simulated, with one standing invitation to watch a real repo.

The reason is arithmetic about the empty case. This instrument is only impressive when agents are
running; a correctly-installed, correctly-configured app watching a quiet repo renders an empty
organism, an empty roster and a zero ledger. A stranger who does everything right sees nothing and
concludes the software is broken. Meanwhile the fixtures are not mockups — they are real event
data through the real reducer and the real renderer, so what a newcomer sees on launch is *the
actual product*, honestly framed.

**The simulated fleets therefore become a first-class feature** (ruling 6), not a hidden developer
shortcut behind undocumented keys.

## Ruling 6 — demo mode is permanent, reachable, and unmistakable

The fixture fleets — the twenty-lane fleet and the staged-pathology fleet — are promoted to a
shipped capability: reachable from the menu at any time, on any surface, with chrome that cannot
be themed away, dismissed or hidden (prd-35 ruling 2's non-negotiable list carries the
distinction). They serve three jobs: onboarding, showing a colleague what the tool does without
waiting for a fleet, and seeing failure modes you hope never to see live.

The one hard rule: **a screenshot of demo mode must never be mistakable for telemetry.** That is
what the permanent chrome buys, and why it is on the never-configurable list rather than in
settings.

## Ruling 7 — the wizard is a path through connect and settings, and owns no controls

prd-35 ruling 1 divides the ground: settings changes things, `/connect` proves things. The
first-run wizard **drives both and reimplements neither** — it walks a person from launch to a
watched, wired repo by rendering the concierge's repo picker, settings' own fields and connect's
own verification rows, in a guided order, and then gets out of the way.

If a seam needs a small affordance to be wizard-drivable, that affordance lands in the surface
that owns it, under the ordinary laws, and the wizard consumes it. **The shell never grows a
private fork of a surface** — ruling 4's clause, restated for the wizard's own controls.

## Ruling 8 — notifications are the tray's reason to exist, and every one is a preference

The daemon (ruling 2) earns its keep by telling you something you would otherwise miss: a lane
**needs a human**, a lane **died**, work **landed**, or **spend crossed a threshold you set**.
Each is individually toggleable in settings (prd-35 S1), each may be muted, and the threshold is
a value a person owns.

The tray badge carries the fleet's own attention state at OS level — the attention ladder,
promoted to the desktop. **The badge and the notifications never disagree with the instrument**:
both read the same derived fleet, so a quiet tray means a quiet fleet rather than a muted one.
A muted notification still moves the badge; muting is about interruption, never about hiding.

## Ruling 9 — signing is a switch the pipeline already has, and the money is spent at a release

Ruling 3 stated the costs so the decision could be made with them on the table. The decision:
**defer.** The packaging pipeline is built so that signing is configuration rather than
rework — certificates, notarisation and the update feed's signature checks are wired and
switched off — and builds ship unsigned with install instructions that say plainly what the
operating system will warn and why.

The reasoning, on the record so it can be revisited honestly: this instrument's users today are
developers who clone repositories and run `npm install`, and who run unsigned binaries daily.
Signing buys trust from people who do not already have it — a portfolio visitor, a stranger, a
non-technical colleague — and that audience arrives at a release, not at a merge. The money
(~$120/yr Windows, ~$99/yr Apple) is spent when there is something to sign for someone.

## The specification

Six answers per surface, per `docs/prds/README.md`.

### S1 — first run

**What and why.** A stranger goes from installer to watching their own repo without reading
anything.

**The path.** launch → **demo fleet, labelled** (ruling 5) → *watch my own repo* → repo picker
(the concierge's, reused) → conductor launch or the copyable command → verification rows live
(connect's, reused) → done, watching.

**States.** *first launch ever* (the path above) · *launched, never configured* (same path,
resumable at the step reached) · *configured* (the wizard does not appear; it is reachable from
settings) · *step failed* (the wizard stops on the failing verification row and shows that row's
own remedy — never its own copy of it) · *demo declined* (a person who goes straight to
configuration skips the demo without argument).

**Data source.** `GET /api/concierge/repos`, `GET /api/doctor`, `GET /api/meta` — all existing.
The wizard adds no server route (prd-34's existing non-goal, restated).

**Interactions.** Keyboard-completable end to end; every step skippable; nothing modal that
cannot be escaped.

**What would make it wrong.** A control here that also exists in settings · a verification claim
the doctor does not make · a wizard that cannot be exited · a demo that is not marked.

**Acceptance.** A test drives the whole path with injected fetches; a test asserts every control
the wizard renders is imported from settings or connect rather than defined locally.

### S2 — the tray daemon

**What and why.** The fleet is a background fact with a window, not a window with a process.

**States.** *watching, calm* · *watching, something needs a human* (badge) · *watching, something
died* (badge, distinct) · *not watching* (no repo configured) · *server unreachable* (the shell
survives and says so; it does not exit) · *quitting* (explicit, from the tray only).

**Data source.** The derived fleet, via the same stream the window uses.

**Interactions.** Closing the window leaves the watcher running · the tray menu offers open,
settings, demo mode, and quit · launch-on-login is offered during setup and toggled in settings ·
notifications per ruling 8.

**What would make it wrong.** Quitting on window close · a badge that disagrees with the
instrument · a notification a person cannot turn off · launch-on-login enabled without being
asked.

**Acceptance.** Closing the window and reopening shows an uninterrupted session; every
notification condition is individually mutable; a muted condition still moves the badge.

### S3 — updates

**What and why.** An app that runs unattended must not restart under a running fleet.

**States.** *up to date* · *downloading* (silent) · *ready, will apply on restart* (a quiet,
dismissible note; never a modal) · *failed* (silent retry, surfaced only in settings) ·
*unsigned build* (the note says so, once).

**Interactions.** No mid-session restart, ever. A person may restart to apply immediately.

**What would make it wrong.** An update that interrupts a watched fleet · a modal · a silent
failure that never surfaces anywhere.

**Acceptance.** A test asserts no update path can trigger a relaunch while the fleet is live.

## Sequencing (waves, each gated as ever)

No lockfile freeze exists today — zero open code PRs — but the Electron dependencies are a
serializing `package.json` change: coordinate the lockfile with any open code PR at dispatch.

1. **Keystone:** shell + spawn + embedded window — the app exists and renders the real
   instrument; everything after this decorates a working thing.
2. Tray, close-to-tray, run-on-login, updater wiring.
3. Installers, signing, and the first-run wizard.

Unfiled work implied, described not numbered: the shell package and its spawn contract; the
tray lifecycle; the signing pipeline and its two accounts; the wizard.

## Open questions

- **N** — the minutes number in success 1 is measured at a stranger-run (prd-15's own device),
  not guessed here. Open, not ruled.
- **Platform order** — Windows first is implied by the cohort's machines; whether macOS ships
  in stage 1 or waits is still the operator's — but the money question itself is settled by
  ruling 9 (defer, pipeline ready). Open, not ruled.
- **Update channel shape** — a single stable channel is proposed; anything richer waits for a
  reason. Open, not ruled.
- **Where the shell's own settings live** (run-on-login, update cadence) — tray menu or a
  settings disclosure in chrome; the charter governs either. Open, not ruled.
