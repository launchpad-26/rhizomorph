# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Semver policy

What counts as a breaking change here is narrower than "anything visibly
different," because most of what's on screen is deliberately allowed to
evolve without a major bump:

- **Breaking (major):** the CLI's public surface — its subcommands, flags,
  and their meaning (`rhizomorph [path] [options]`, `rhizomorph doctor`,
  `rhizomorph env`) — and the shape of `.swarm/lanes.json`, the one file
  another tool (a dispatcher, a conductor) is expected to write and this
  one is expected to read. Removing a flag, changing a flag's default in a
  way that changes behavior, renaming an existing field in the lanes
  manifest schema, or dropping a documented HTTP API route all count.
- **Not breaking (minor or patch):** the scene's visual grammar — colors,
  motion, layout, what a pathology looks like — the shape of internal
  telemetry events, the on-disk session-log format under
  `~/.local/share/rhizomorph`, and anything under `packages/web` that isn't
  reachable through the two contracts above. These can change release to
  release; nothing external is meant to depend on them holding still.
- Adding a new flag, a new optional field, or a new subcommand is a minor
  bump. Bug fixes that don't change either contract are a patch bump.

## [Unreleased]

Everything below landed on top of 0.1.0 and has not yet been cut into a
tagged release — publishing itself is still gated on an open operator
decision (see the README's ["When this is published to
npm"](README.md#when-this-is-published-to-npm)). Grouped by era, newest
first; full write-ups are in the numbered `docs/prd*.md` files and
[`docs/architecture.md`](docs/architecture.md).

### Added

- **A team server deployment can now be configured for GitHub sign-in (prd-51
  ruling 9, #538).** Six `RZ_TEAM_GITHUB_*` values — org, app id, installation
  id, client id, client secret, and the private key's path — configure the app
  container. The private key itself is never passed as an environment value:
  it is read from a file mounted **read-only** at the path named by
  `RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH`, because a compose `.env` truncates a
  multi-line PEM at its first newline. The boot report now names all six
  effective values, each saying who set it and where, with both secrets shown
  redacted rather than in the clear. An unconfigured deployment still boots
  and `/auth/github/start` / `/auth/github/callback` still answer 503 — a
  deliberate refusal (#169), not a defect, so upgrading with no credentials in
  hand changes nothing about whether the server comes up. This makes sign-in
  configurable, not visible: there is still no browser view behind it, and
  reading what a session recorded still means a direct database read. The
  operator recipe is in
  [`docs/team-server-runbook.md`](docs/team-server-runbook.md).

- **`/connect` gains a `repo ↔ team server` row: has a batch this repo shipped
  ever been acknowledged, and when (prd-51 ruling 12).** The row reads
  VERIFIED only once the shipper's cursor records a real acknowledgement,
  stating the fact and its timestamp; UNPROVEN for a shipper that is off, or
  configured but has never shipped anything yet — "connected" never means
  preconditions passed; and BROKEN with the exact remedy when the shipper is
  on and cannot run. The doctor's own `shipper` check (`rhizomorph doctor` and
  `GET /api/doctor`) now carries that same timestamp as an optional
  `lastAckAt`, taken as the most recent acknowledgement across every session
  in the cursor — the local wall clock the cursor already kept never crosses
  the wire; this only surfaces it to the operator.

- **`rhizomorph archive` — seal, archive, verify, tombstone and prune are one
  local command, in that order, or it does not run (prd-51 ruling 11, #432).**
  One subcommand builds the portable record for every session older than the
  age you name, gzips it to
  `<repo-slug>-<session>.rhizorecord.json.gz`, verifies that archive **read
  back off disk**, writes a tombstone manifest beside the log **while the log
  still exists**, and only then prunes that one log. Every step gates the next:
  an archive that does not verify, a capture manifest naming a lane the log
  never does, or a log that is bytes-on-disk but not one parseable event all
  refuse the candidate and leave its log exactly where it was — and one refused
  candidate never costs its siblings their archive. `--older-than` is
  **required** (`30d`, `90m`, `0d`; a bare number is refused), because a
  default retention age would be a policy that reaps a lane nobody thought
  about; `--dry-run` reports the plan in retention's own voice and writes
  nothing. The tombstone is what makes a pruned lane still read as *pruned*
  rather than as one that never ran, and it names lanes git alone knows about —
  a non-main worktree branch with no instrumented agent — as well as the ones
  telemetry attributed, saying out loud how many came from each.
  `attributedFrom` gains `'tombstone'` as a declared value. Prune is reachable
  by no other route: `log/archive.ts` is the only shipped importer of
  `log/retention.ts`, and a law holds it there.

- **A saved comparison carries the measure and the facts that judged it, and
  the measure switch works again on reopen (prd-14 ruling 6, wave 4, #347).**
  A `version: 2` comparison artifact stores, per run, `{ verdict, detail?,
  cost, duration, commits }` — the compare surface's own vocabulary, never the
  server's `LabRunOutcomeDTO` — and, per artifact, the `measure` that was
  showing at save time and the gate's own `provenance` (`verifyCommand`,
  `source`, `measuredAt`). Reopening one re-derives through `runForMeasure`,
  the SAME function the live surface uses, so cost/duration/commits/verified
  are all switchable on a reopened comparison, which `version: 1` could never
  offer. A `version: 1` artifact is still READ, not migrated — the measure is
  unrecoverable from it, so there is no upcast — and it keeps the existing
  "measure not recorded" voice; a `version: 2` artifact whose measure was
  dropped falls back to that same voice rather than guessing a basis. Version
  3 and above still refuse by name. Both parser copies
  (`packages/web/src/lab/compare/artifact.ts`,
  `packages/server/src/comparisons/artifact.ts`) moved together, proven by the
  shared fixture and the two agreement laws (ADR-0049).

- **The shipper, the fifth hand (`rhizomorph connect team`)** — off by
  default and per repo. Once enabled by that explicit command, a batch timer
  run in the foreground by `rhizomorph connect team --ship` tails this repo's
  session ledgers and posts them, re-serialized through the current event
  schema, to one team server under one project-scoped `rzk_` ingest key
  (read on stdin, stored `0600`, never printed and never logged). Nothing in
  the server, a collector or a poll can start it. The README's Trust section
  is rewritten accordingly: it no longer says "nothing, ever, off this
  machine", it says what leaves, when, to whom, under whose key and how to
  see that it is on. ADR-0034, prd-51 rulings 2, 3, 7 and 12.
- **The recordings library lists a saved comparison as its own kind, and
  reopens it into the comparison surface (prd-14 ruling 5, wave 3, #214).**
  `GET /api/lab/comparisons` gets its first web caller: the History page's
  session axis now shows a Comparisons table beside the recordings table —
  its own columns, its own actions, never a session row wearing a different
  label. Selecting an available one reads it by id and reopens it into
  `ComparisonSurface`, recomputed from the stored `ComparisonInput` by this
  repo's own `compareArms`; an artifact an older format version wrote answers
  `{ available: false, reason }` at both the list and the single-read route,
  and the reader puts that reason on screen by name — never an empty state,
  never a console error. Saving is reachable from the comparison surface
  itself now too: `ExperimentComparison` carries a save control wired to
  `POST /api/lab/comparisons` (the app's seventh mutating call,
  `lab/compare/save.ts`), so the whole save-then-reopen round trip is
  completable by a human with no fixture. No migration is written for an
  older version — it refuses, as ruling 5 always said it would.

- **One hover vocabulary, and a law that says the whole sentence (prd-30 S1,
  #221).** The disclosure card's law used to check one thing — that nobody had
  copied *this* card — which said nothing about a surface growing a different
  one. It now asserts prd-30's actual sentence: no directory outside
  `disclosure/` renders card chrome, where card chrome is a positioned panel
  opened on hover or focus whose content is prose rather than controls
  ([ADR-0044](docs/adr/0044-card-chrome-is-prose-on-hover-not-a-menu.md)). The
  timeline's mark menu stays a menu — it is a list of places to jump to, not a
  condition — and it stays by definition rather than by exception, so the law
  needs no allowlist and none of it has to be revisited when the next panel is
  written.

### Changed

- **The last native tooltips are gone — every mark now explains itself on
  hover, on focus and on tap (#389).** Twelve `title=` attributes retired from
  the scene, the replay dock and the concierge button, which completes prd-30:
  nine became disclosure cards, and three that were only field labels or a
  keyboard-shortcut hint became accessible names instead, because a card whose
  reason rests on no evidence is noise rather than disclosure. The law that
  forbids a native tooltip now walks the whole of the web package — its
  exemption list is deleted, not emptied.
- **Three controls that explain why they are unavailable stay reachable
  (#389, ADR-0047).** "Replay this session's birth" with nothing recorded,
  "Play" before a session is chosen, and the scene's motion toggle while motion
  is stilled in settings each carried their reason in a tooltip on a `disabled`
  button — which drops out of the tab order, so the explanation was the one
  thing a keyboard user could never get to. They now stay focusable and refuse
  to act, so the reason is reachable by keyboard and by pointer alike.

- **The timeline dock's four transport buttons dropped their tooltips (#221).**
  Every one already carried its name for a screen reader; the `title=` beside it
  was a second, slower, pointer-only copy. The zoom-in button's name now says
  what its tooltip said — that it zooms on the playhead — rather than losing it.

- **Every mark explains itself on hover *and on focus* (prd-30 ruling 1,
  charter §6, #220).** The instrument's 50 remaining native `title=` tooltips
  are gone. A native tooltip is delayed by about a second, invisible to a
  keyboard, absent on touch and unstyleable — so the fleet table's state, cost,
  age, threads and fence cells, the drawer's vitals, the burn strip's figures,
  the ledger's rows and sub-rows, the recordings and lane pages, the attention
  chips, the collision matrix, the trace tree and the why surface now open the
  shared disclosure card instead: the condition's name, why it is so *with the
  evidence and how old it is*, and the exact next act with a command where one
  exists. Whatever hover discloses, focus discloses — every one of them is
  reachable with the Tab key, and `Escape` closes the card and hands focus back
  to the mark.
- **A mark that is already a control discloses too, without a second button
  ([ADR-0041](docs/adr/0040-a-mark-that-is-already-a-control-still-discloses.md),
  #220).** `Disclosure` gained a `trigger` mode so an attention chip, a ledger
  jump or a touched-file button can carry a card without nesting a button
  inside a button.

- **A finished comparison is stored beside the recordings it derives from
  (prd-14 ruling 5, wave 1, #213).** `POST /api/lab/comparisons` saves a
  comparison artifact as a sidecar under the repo's recording directory —
  `comparisons/comparison-<id>.json`, the posture captured transcripts and
  labels already hold ([ADR-0041](docs/adr/0041-a-saved-comparison-is-a-sidecar-not-an-event.md)) —
  and `GET /api/lab/comparisons` / `GET /api/lab/comparisons/:id` list and
  read them back. The save is token-gated exactly as `/api/lab/launch` is,
  and refuses in replay mode the way the label save does. An artifact whose
  format version is not the current one is refused **by name**
  (`unsupported comparison artifact version: 2`) and left untouched — never
  migrated silently. The server keeps its own copy of the web's parser
  ([ADR-0042](docs/adr/0042-the-server-parses-a-comparison-artifact-with-its-own-copy.md)).
  Nothing in the browser reaches these routes yet; that is #214 — written
  here as wave 2, and renumbered to wave 3 when #376 was filed between the
  two. The sequencing in the PRD is the authority.

### Changed

- **Some explanations are phrased differently (#220).** Sentences that used to
  be one tooltip string are now the card's label, why-with-evidence and remedy.
  The claims are the same; several read more fully, because a remedy that used
  to be a clause is now a named act — and, where one exists, a command kept
  apart from the prose so it can be copied.

- **A lapsed declaration reads as lapsed, and configured-but-silent says so
  (prd-27 rulings 3 and 6, #218).** A hook beacon that goes quiet while the lane
  keeps working stops being believed after `BEACON_LAPSE_MS` — a value
  *measured* from three real Claude Code sessions with the hooks installed and
  derived in
  [`docs/design-notes/beacon-lapse-interval.md`](docs/design-notes/beacon-lapse-interval.md)
  (3× the longest gap between beacons inside an active turn, floored at twice
  the transcript organ's settle window); a `waiting` beacon lapses only once
  work follows it, so a long wait on a human is never doubted. The fleet falls
  back to the inferred reading and the STATE card says `declared attention
  lapsed Nm ago; reading turn shape`. `rhizomorph doctor` prints one line per
  present lane — never declared, hooks configured but no beacon for this lane
  yet, declared, or lapsed — off the same fold the dashboard reads. The
  capability ladder now tells **L2** (attention declared by the harness's own
  hooks) from L4 (declared by tmux/workmux): `attention` carries a `witness` on
  the manifest
  ([ADR-0039](docs/adr/0039-attention-names-its-witness-on-the-manifest.md)),
  the beacon's manifest reads `partial` with the configured-but-silent reason
  until a beacon arrives and `provided` after, and a configured-but-silent hook
  can no longer read as the PTY rung. The sessionlog organ's remedy names
  `rhizomorph env <lane> --hooks claude` instead of a beacon that "would" exist.

- **The setup wizard switches the watched repo (prd-20 ruling 5, #216).** Choosing a
  repo other than the one this instrument is watching no longer ends in a sentence
  saying the switch "is not built": the conductor step offers it, behind one arming
  click that says what it costs — the current recording closes as `retargeted` and a
  new one opens under the new repo's slug; lanes launched before the boundary are
  refused whole until their env is re-issued — and the answer renders the route's
  own account: both session ids, the lanes affected, the paste-ready re-issue
  commands, what stops and what keeps working. A refusal (`already-watching`,
  `writer-alive`, a replay server) is shown as itself, distinct from a failure and
  from a success. The restart command stays beside the switch as the no-trust
  path. `concierge/retarget.ts` is the app's sixth mutating call and carries its
  own contract test. `SECURITY.md` no longer says the route has no caller.

- **The fleet believes a declaration, and a disagreement says so (prd-27
  rulings 3–4, #283).** A hook beacon whose kind is in the ruled vocabulary now
  folds to one declared-attention record per lane (`SessionState.declared`,
  latest by the writer's clock), and the fleet reads it as a third witness: a
  declared `waiting` is a certain WAITING since the moment the hook fired —
  *named blocked because it said so* — a declared `working` newer than the
  lane's last work quiets both inferred WAITINGs (pane stillness and transcript
  shape), an inferred `working` never quiets a declared `waiting`, and a
  `stopped` alarms nothing. Between two declarations the newer word stands.
  Every disagreement is voiced on the STATE hover card, byte-deterministic —
  `beacon (claude-hook) declares waiting 40s ago · transcript shape reads
  working` — never resolved in silence. `beacon` joins `/api/meta`'s capability
  ladder (rung unchanged: its manifest is all-absent until w4) and the status
  bar's sources as a sixth pill, `Beacon`. The staged pathology fixture's
  waiting lane is now beacon-declared with the roster's stale `working` voiced
  beside it, so the STATE-hover screenshots this wave owes can be captured in
  one command once it lands on `main` (they are captured there, not here — a
  lane's `capturedAt` cannot be a `main` ancestor).

- **`agent.status` names its witness, and the transcript organ speaks (prd-27
  ruling 2 — the keystone, #281).** The envelope that pinned every attention word
  to `workmux` now also accepts `sessionlog`, and the transcript-tail state
  machine publishes its working/waiting transitions through it — edge-triggered,
  frozen and gone withheld, signed with its own name. `AgentState` records
  `witness` (whose word the status is) and `dissent` (a later inference a
  standing declaration overruled), and the fleet renders the difference: a
  workmux WAITING is certain and names any disagreement beside it (`workmux
  reports waiting 1m30s; transcript shape reads working`); a transcript-shape
  WAITING carries the `~` mark and the organ's own reading as evidence. prd-27
  ruling 4's asymmetry — a declaration may raise a summons, an inference alone
  may only withdraw an inferred one — is one `if` in the reducer: a standing
  workmux `waiting` or `done` is never displaced by the organ's word (a finished
  lane stays DONE when the organ reads its idle session as waiting); only a
  declared `working` yields to an inference.
  [ADR-0037](docs/adr/0037-agent-status-names-its-witness.md) records why a
  second literal beat a second event type and beat a payload field; the golden
  era-1 snapshot is re-blessed for the two new keys and
  `packages/core/src/eras/CAPTURE.md` says why.
- **A hook can declare a lane's attention (prd-15 ruling 2 / prd-27 ruling 4, #282).**
  `rhizomorph env <lane> --hooks claude` prints the Claude Code `settings.json`
  `hooks` fragment whose four one-line commands append an ADR-0036 beacon —
  `Notification` → `waiting`, `Stop` → `stopped`, `UserPromptSubmit` and
  `PostToolUse` → `working` — to the running instance's
  `<data root>/<repo slug>/beacons/claude-hook.jsonl`, creating the directory
  first and only ever appending. The three words are now the ruled vocabulary,
  `BEACON_ATTENTION_KINDS` in core; the schema stays open. The beacon fixture is
  a real capture from a session running the printed hooks, and its
  `CAPTURE.md` is the recipe.
- **The beacon door exists (prd-27 ruling 1 / prd-17 ruling 2, #217).** A seventh
  collector, `beacon`, tails every `*.jsonl` file in the watched repo's own beacon
  directory — `<data root>/<repo slug>/beacons/`, beside its recordings — and
  records each one-line JSON beacon as a `beacon.received` event carrying who
  wrote it, what kind, which lane, when (the writer's own clock), and a sha256
  digest pointing back at the line. A malformed line — a blank one included — is
  skipped, counted and named in one `collector.error` per file per tick, never
  fatal, and every event's byte offset points at the bytes it digests. No route,
  no token, no server needed at the moment a hook writes
  ([ADR-0036](docs/adr/0036-a-beacon-is-a-line-in-a-watched-directory.md)
  records the directory and line contract, and why a file beat a route).
  Nothing folds a beacon yet and no emitter writes one yet: the collector's own
  manifest says `attention: absent` with the reason, and the provenance bar still
  lists five sources — declared attention, its lapse and the hook emitter are
  prd-27's next waves (#218).

- **The native Windows suite result is a committed list of files, not a number
  (prd-25 wave 3, #212).** `.github/workflows/windows-suite.yml` runs the full
  suite on `windows-latest` on every push and holds it to
  `.windows-known-failures`, per file: a failure outside the list turns the job
  red, a listed file that now passes is reported as a removal candidate, and
  every entry carries one of prd-25 ruling 3's cause classes (seven, after the
  amendment the first run forced) with the evidence beside it. The list is expected-fail, not skip — every entry is
  reported on every run. The README's Windows row moves accordingly.

- **Native Windows enters CI — the built clone's boot is witnessed on every push
  (prd-25 wave 2, #211).** `pack-smoke` now runs on `windows-latest` at both node
  legs: it packs the repo, installs the tarball into a clean project and boots the
  installed CLI under Git Bash, the first CI leg ever to exercise the
  `pathToFileURL` fix that let a built clone boot on win32. The README's support
  matrix row for native Windows moves from "unverified" to an honest partial —
  installs and boots, suite not run — and cites the leg by name.
  `scripts/pack-smoke.sh` gains a Windows branch: the run's processes are found
  through WMI by a per-run token in their command lines, terminated if the
  group TERM left any alive, and the leak check on that runner reports through
  the same self-checking query instead of degrading to "pgrep unavailable".
  The same run found a defect every platform had: `boot_and_check` read the
  stop verdict through a subshell that could not observe the parent's jobs, so
  every boot waited the full grace period and reported "killed" — the verdict
  now travels in a variable, and the Linux and macOS legs dropped from about
  60 seconds to under 40.

- **The flat instrument's first wave: three costs that grew with use no longer do
  (prd-44 wave 1, #30/#31/#33).** A finished recording is now parsed **once**
  rather than once per request — `GET /api/lane-index` re-read and re-parsed every
  recording on disk every time, measured at 344 ms per request on a 4-file,
  61,157-line directory and falling to 130 ms with the parse cached
  ([ADR-0028](docs/adr/0028-bounded-lru-cache-for-parsed-session-logs.md) records
  the bound and why the *answer* is never cached, only the parse). The session log
  is now opened **once per session** instead of once per event, 61.4 µs of
  open/close per event becoming a held descriptor released on `sync()` — 4.1x on
  the path every recorded event takes, with the bytes on disk unchanged. And a
  bounded fan-out helper now exists at a stated ceiling, order-preserving by
  construction because the record is hash-chained
  ([ADR-0009](docs/adr/0009-portable-hash-chained-record.md)) — nothing consumes
  it yet; prd-44 wave 2's collectors are what will.

  Two honest limits, measured rather than assumed. The lane-index stall improves
  2.6x but does **not** vanish: `buildLaneIndex`'s fold is 107 ms of the
  remaining 116 ms, so prd-44 ruling 1's claim that steady-state work falls "to
  the one recording still moving" is not yet true, and the residual freeze became
  *shorter but less interruptible*. And the wave's fourth issue (#32, the retired
  lane's tessellation) was built, measured at a **net regression** at its own
  named configuration, and refused rather than landed — the win is real for
  settled marks (6x) but the approach charged living lanes for it.

- **The identity seam's keystone: seven reads now answer only the token's
  holder (prd-29 wave 1, #442).** `GET /api/sessions`,
  `/api/sessions/:id/events`, `/api/transcript/:lane`, `/api/lanes`,
  `/api/lab/checkpoints`, `/api/lab/experiments` and `/api/lab/estimate` now
  refuse a tokenless request with `401`, the way the mutating routes already
  do — a fourth route class, `gated-read` (ADR-0024, amending ADR-0014).
  "Gated" is now a build law: the route-class walk fails any gated row whose
  route does not actually carry its `preHandler`. Token comparison is
  constant-time (`timingSafeEqual`). The SPA sends the header on every read
  through one shared module and is unaffected; `GET /*` stays tokenless, the
  bootstrap the in-band token (ADR-0012) depends on. `/api/meta`, `/api/doctor`
  and `/api/stream` are deliberately still open (wave 2), so nothing outside
  the browser breaks mid-milestone.
- **A worktree's open git-status incident is visible again (#606).** The
  fleet table's lane row now marks a lane whose worktree has failed `git
  status --porcelain` four or more times in a row and not yet recovered — the
  fact has been recorded since #537 (`WorktreeState.dirtyStatusFailedSince`,
  ADR-0022) but had no reader on screen until now.
- **The honest middle gets a voice (prd-22 ruling 2, #304).** A collector that is
  answering but degraded — retrying after consecutive failures, not yet disabled —
  now reads `degraded` in the provenance bar's per-source pill (distinct from a dead
  `disabled` source and from a one-off `errored` blip) and speaks the same
  what/why/`rhizomorph doctor` gap voice a disabled collector already does. It stays
  ambient: unlike `error`, it never escalates to the attention strip, since it may
  self-heal on the very next poll.
- **`POST /api/retarget` — the watched repo can change without a restart
  (prd-20 ruling 5, #389).** One explicit human act switches the instrument
  from one repo to another in place: it validates the candidate first (it
  exists, it is a git work tree, no other rhizomorph is recording it), and
  only then closes the session in the old repo's directory and opens one in
  the new repo's, re-points every route's context, and rebuilds the poll loop
  against the adopted repo. It never spawns a second instance. A failed
  validation is a `409` with the old target completely untouched — the
  recording still open, its lock still held — which is the whole reason the
  spike (#265) chose rotate-and-reinit over supervised respawn, whose
  equivalent failure is an uncatchable `SIGABRT`. Token-gated like every other
  mutating route (#234), and `retarget-law.test.ts` holds ADR-0014 grant 3
  over it against the raw import graph: no collector, no poll and no timer
  reaches it, gate or no gate. `/api/meta` now reports `lastBootReason:
  'retargeted'`, so the provenance bar says the predecessor is under another
  repo's slug rather than implying it is the previous log in this repo's
  picker.
- **A session's end can say it was a retarget, and the two logs can find
  each other (#384).** `session.closed` accepts `reason: 'retargeted'`
  alongside `'rotated'` — prd20 ruling 5's repo switch ends a session too,
  and recording it as a rotation would be a lie, because a rotation's
  successor is the next log in the same directory while a retarget's is
  under a different repo slug entirely. So both events also gained an
  optional pointer: `session.closed.successor` names the slug dir the run
  continued in, and `session.started.predecessor` names the slug dir and
  session id it came from. Additive — every recording written before this
  parses unchanged, and an ordinary boot or rotation carries no pointer at
  all. Nothing emits the new reason yet; the machinery is #385–#391.
- **`export-record --force` (#298).** An explicit `--out` that already
  exists is now refused with an error naming `--force`, which overwrites;
  the flagless default artifact is regenerable and always refreshes.
  `--force` without `--out` warns instead of silently doing nothing, and
  an `--out` naming a directory is named as such rather than advised a
  `--force` that would not help.
- **System agnosticism (prd15).** A transcript-tail state machine derives a
  lane's liveness and attention (`working`/`waiting`/`frozen`/`gone`) from
  the agent CLI's own session transcript alone — no tmux, hooks, or
  cooperation from the agent required. Every collector now declares which
  of six signals it can speak to, folded into a named "enrichment rung"
  (L0 zero-cooperation through L4 tmux/workmux) that `rhizomorph doctor`
  and `GET /api/meta` report per lane.
- **Sessions are a thing you can hold (prd16).** An explicit operator act —
  `rhizomorph rotate`, or the dashboard's "end session · start fresh"
  button — closes the current recording and opens the next one; a
  pid+heartbeat lock stops two instances from racing onto the same session
  log; `--resume-window <ms>` makes the resume boundary configurable and
  self-explaining. Each lane's live transcript is captured, redacted, into
  its session's own recording on close, so a replayed recording still shows
  real conversations on another machine, a year later. A new `/recordings`
  library lists every recording, with rename-in-place and export.
- **The TIDE (prd13).** The replay bar grew a body: a chapter-mark lane
  over a time axis, with portaled hover cards, cursor-anchored zoom, and
  `[`/`]` chapter stepping. (An earlier, richer per-lane density-band
  version was built, given three rounds of affordances, and cut outright
  by the operator once it still read as noise in practice — see
  `docs/prds/done/prd-13-tide.md` ruling 13.)
- **The drawer, tabbed (#163/#164).** ACTIVITY, CONVERSATION, WHY and TRACE
  each get the drawer's full height instead of four independently-capped
  boxes, opening on ACTIVITY by default. The conversation view now caches
  the last-good page it read per lane and never blanks on a transient
  server hiccup (#191).
- **Recordings never rot (prd17).** An event line from a future era this
  build doesn't recognize is counted and voiced rather than silently
  dropped; one real recording per era folds byte-identically in CI against
  a committed snapshot; an `upcast()` chokepoint is reserved for the day a
  real schema migration is needed.
- **The trace era (prd9).** A beta OTLP trace layer (Claude Code's own
  span export) surfaces a request waterfall in the drawer's own TRACE tab,
  with dollar estimates for non-instrumented setups backed by a
  SHA-pinned, vendored Langfuse pricing table.
- **Provenance and the portable record (prd11).** File-level provenance
  (transcript moment → tool call → file touched → landing commit); a
  portable, hash-chain-integrity-checked session record
  (`rhizomorph export-record` / `rhizomorph replay <record>`) — see
  [`docs/record-format.md`](docs/record-format.md).
- **The laboratory (prd12).** A second, explicitly-invoked hand —
  `rhizomorph lab checkpoint|fork|compare` — for forking a lane's live
  workspace and conversation into its own worktree to try something risky,
  under its own write-scope namespace law, entirely separate from the
  read-only observer.

### Security

- **`POST /api/rotate` and `POST /api/lab/launch` now require the capability
  token (#234).** Both were reachable by a plain `curl` from any local
  process — a compromised dependency, another tool, malware running as you.
  The mutation guard deliberately admits a request carrying no `Origin`
  (every non-browser caller), and `requireCapabilityToken` had only ever
  been applied to `/api/label`. Rotation ends the operator's recording;
  the launch route forks a worktree and dispatches a live agent that spends
  real money. Both now carry the same gate `/api/label` has carried since
  the 2026-08-06 audit. All three of their callers were widened in the same
  change rather than a follow-up — the dashboard's rotate button, the lab's
  launch panel, and `rhizomorph rotate` — because gating a route whose
  callers cannot authenticate is exactly how #249 shipped.
- **An arm's `model` is validated against `^[A-Za-z0-9._:-]+$` (#234).** It
  was checked as `typeof === 'string'` and nothing more, then interpolated
  into `` `bash scripts/lane-agent.sh ${model}` `` — a *string* workmux runs
  through a shell in a tmux pane, so a `model` carrying `;`, `$(`, a
  backtick or a space ran a second command as the operator. Chained with
  the ungated route above, that was unauthenticated local code execution,
  which is why the two landed together. Refused now at the HTTP boundary
  and again in `lab/fork.ts`, which covers `rhizomorph lab fork --model` —
  a path no request crosses. Every hop inside rhizomorph already used argv
  arrays; the injection landed one hop downstream, in workmux's own
  execution of that string, which is why an audit of this repo's spawn
  sites cleared it. `lane` is refused a leading `-` for the adjacent
  reason: it travels as an argv positional, where a `-`-prefixed value is
  read as a flag. Deliberately disclosed blast radius: a model id
  containing `/` or `@` — a Bedrock inference-profile ARN, a
  provider-prefixed id — is now refused as well. Every model string this
  repo dispatches passes (`sonnet`, `opus`, `haiku`, `claude-opus-5`,
  `claude-3-5-sonnet-20241022`, and a bedrock-style
  `us.anthropic.claude-3-5-sonnet-20241022-v1:0`).
- **The loopback `Host` check now runs for every request, not just
  mutations (#235).** A DNS-rebound page could previously read
  `/api/transcript/:lane` and the `/api/stream` SSE, because every GET
  returned early past the guard. Deliberately disclosed blast radius: a
  request whose `Host` spells anything outside `127.0.0.1` / `localhost` /
  `::1` / `[::1]` (a numeric `:port` is fine after all but bare `::1`, which
  takes none — bracket it to add one) is now refused with a 400
  on **every** route, where reads used to pass. Concretely that now refuses
  `curl http://0.0.0.0:PORT/...` (dialling `0.0.0.0` reaches a
  `127.0.0.1`-bound socket as a Linux/macOS convenience), Host-less HTTP/1.0
  requests, and the trailing-dot `localhost.`. Address the instrument as
  `127.0.0.1` or `localhost` instead — see
  [troubleshooting](docs/user-guide/troubleshooting.md#refused-host--is-not-loopback).
  `0.0.0.0` was considered for the accepted set and rejected: it is the
  unspecified address, not a loopback name, and the dial-through is not
  portable (the rationale lives on `LOOPBACK_HOSTNAMES` in
  `packages/server/src/server/mutation-guard.ts`).

### Removed

- **`pane.activity` no longer carries `preview` (#292).** The tmux
  collector used to put the last non-empty line of every `capture-pane`
  into the event, which meant a stranger's terminal text was written to the
  session log and exported verbatim into a hash-chained record — an
  artefact that, by construction, cannot be redacted after the fact.
  `contentHash` and `lines` already carried every signal the fleet reads
  (the flatline detector compares hashes; nothing rendered the preview), so
  nothing on screen changes. Recordings made before this remain readable:
  the field is ignored on parse, the line still folds, and an old session
  still exports as a complete, verifying record — the value is stripped,
  not the line dropped. One consequence worth stating: re-exporting a
  *pre-change* session after this lands yields a different `chainDigest`
  than an export taken before it, because a record's body is re-serialized
  from parsed events rather than copied from the log's bytes. Files already
  on disk are unaffected. #292's definition of done asks that any override
  path leave a record of having been used; there is no override here,
  because there is no scan and no gate to override — the boundary is the
  event schema itself, enforced at parse time. See
  [SECURITY.md](SECURITY.md#what-a-shared-record-contains) for what a
  shared record does still contain.

### Changed

- **`rhizomorph rotate` now needs the dashboard to be built (#234).** The
  capability token the command must now send is handed out through the
  served page and nowhere else
  ([ADR-0012](docs/adr/0012-in-band-capability-token-delivery.md)), so the
  command reads it the way the browser does: one loopback `GET /`, then the
  `<meta>` tag. A server started without `packages/web/dist` serves a
  placeholder page carrying no token, and rotation there now exits 1 —
  naming `npm run build --workspace packages/web` rather than surfacing a
  bare 401 about a header the operator has no way to supply. Putting the
  token in `GET /api/meta` was rejected: it would hand it to precisely the
  local process #234 defends against. The dashboard's own rotate and launch
  buttons refuse the same way under `npm run dev:web`, where vite serves
  `index.html` itself and the injection never runs — a gap ADR-0012 already
  named and this change does not close, only makes honest.
- **Measured performance fixes.** Dragging the scrubber now rebuilds the
  derived fleet once per animation frame instead of once per pointer event
  (#269): the scrub position and the fold it drives are two clocks now, so
  the thumb still tracks the finger exactly while the fold and the
  `buildFleet` rebuild behind it move at a frame's cadence. Where a drag
  used to rebuild once per `onChange` — up to ~120 a second onto a screen
  that shows 60 — the tests that ship with it count 9 rebuilds across an
  80-seek drag over 8 frames, and 13 folds across a 120-seek drag over 12
  frames of a 25,000-event recording. A 55,000-event replay's main-thread load
  time dropped from ~20.9s blocked to ~25ms by folding the incoming event
  stream once per animation frame instead of once per event (#183). A
  30-lane scene with 200 retired lanes dropped from 28.37ms/frame (170.2%
  of the 60fps frame budget) to 11.95ms (71.7%) by caching the unchanging
  part of a scar (#175/#178).
  Replay playback advances the timeline clock on an animation frame rather
  than a 100ms interval (#271), so a playing scene animates at frame rate
  instead of the 10fps its own 60fps ambient loop was being sampled at —
  the cadence changed, not the clock's owner, so #155's single wall-clock
  read in the replay path is untouched.
- An independent, read-only adversarial audit of the whole instrument
  surfaced several findings, triaged into follow-up issues (#171–#177) —
  among them, unscrubbed identifiers in captured OTel fixtures, and the
  still-open question of whether going public means rewriting this
  repo's history or cutting a fresh tree (#177, unresolved).

### Fixed

- **The attention strip names only the chips that fit, and the `+N` marker can no longer be
  pushed off screen (prd-30 wave 5).** The marker was the clipping row's last child, so
  an overflowing row pushed out the one element whose job is to say something is hidden:
  measured in Chromium at 1440x900, the row had 563px for 1522px of chips and the `+1` sat
  941px past the right edge, announcing one hidden pathology while three were invisible. The
  marker is now a sibling of the clipping row, and the row measures itself and folds to what
  it can actually name, so `+N` counts every pathology the reader cannot see. Conservative by
  construction — it can fold a chip that would have fitted, which costs a name rather than
  hiding a frozen lane (`docs/design-notes/attention-chip-width.md`).
- **A disclosure card states its elapsed once, and never invents one (prd-30 wave 5).** The
  card appended `<elapsed> ago` unconditionally, and four of the five shipped conditions broke
  the assumption behind that: FROZEN and WAITING carry the span inside their own evidence, so
  it printed twice — and on WAITING the appended "ago" landed on the last clause of a joined
  list, asserting that workmux reported *working* 8m17s ago when the evidence says two
  witnesses disagree. OFF-FENCE and EXPENSIVE have no time anchor at all and were stamped
  `0s ago`, a duration invented for a trespass path and a token rate. A zero age now reads as
  "confirmed just now", which is what `selectors/condition.ts` always said it meant, and an
  age the evidence already states is not repeated. The teach layer composed the same way and
  is fixed with it.
- **The prd-27 follow-ups land (#307).** `GET /api/doctor` now reads the running recorder's fold, so it reports the same rung as `rhizomorph doctor` and `/api/meta` — L2 on a beacon-only machine — and prints the same per-lane declared-attention readings, from one shared function. `beacon` is the sixth connection source (`selectConnection`, the connect page and `/api/meta`'s `connection` block agree with the status bar's Beacon pill, which no longer derives its own flow). The beacon capture recipe names the key that actually cycles Claude Code's permission mode under tmux (`BTab`). The session-recorder ceiling law carries a 30 s per-test timeout so an 8 GB machine's full suite is green. The PRD's Outcome header and the architecture decisions log now record what waves 1–4 shipped.
- **The activity feed names which witness signed an `agent.status` (prd-27 ruling 2 / ADR-0037, #290).** Since #281 two witnesses publish `agent.status` — workmux's declaration and the transcript organ's inference — and the feed rendered both as one bare word, the #133 false summons in a third costume. A lane row now carries the envelope's `source` as its witness and an inferred word wears the instrument's own `~` mark (`~ waiting`, `~ working`), exactly as the attention strip and the STATE hover already render an inference; a workmux row is byte-identical to before. The tag is exhaustive over the witness type, so a third witness fails typecheck rather than rendering as workmux's word.
- **An event on screen is an event on disk (prd-40 wave 2, #4).** The recorder published
  every event — to the live buffer, to the maintained fold, and to every subscriber —
  *before* awaiting its append, and the poll loop advanced its collector snapshot before
  the recorder had finished writing. A full disk or a permissions change therefore lost the
  event permanently: it rendered live, never reached the log, and the next tick diffed
  against an advanced snapshot so it was never re-derived. Nothing publishes now until the
  append resolves, at all three publishing sites and in the poll loop.

  Two consequences worth knowing. A rejected append leaves the snapshot un-advanced, so the
  next tick re-derives the **whole batch** — including events whose appends already
  resolved, which are appended twice. That duplicate is accepted deliberately
  ([ADR-0029](docs/adr/0029-a-recording-may-repeat-a-fact.md)): an over-reporting record is
  recoverable, a silently lost event is not. And a subscriber that throws after a *durable*
  close no longer reopens the log — the seal is released only when the close did not happen, and
  such a subscriber is reported rather than failing the close, so a rotation always reaches the
  next session.

- **A resumed session's open dirty-status incident now actually closes (#536).**
  `worktree.dirtyStatusFailedSince` (#429) is rebuilt by the fold from the event log, but
  its close was voiced only from the git collector's own in-memory failure counter — a
  resumed process with no memory of a prior incident (no persisted snapshot, or one that
  lags the log) could never observe a "recovery" to voice, so a healthy `git status`
  after a resume left the flag latched forever. The first live poll after a resume now
  reconciles the fold's still-open incidents against that poll's own dirty-status read,
  the same way `withBranchReconciliation` (#139/#449) and `withAgentReconciliation` (#418)
  already reconcile branches and agents.
- **A recovered worktree's git-status recovery no longer masks a sibling
  worktree's still-failing git status, and a still-failing worktree's alarm
  no longer gets misattributed to whichever worktree last reported one — both
  now voice as `worktree.dirtyStatusFailed`/`.dirtyStatusRecovered`, facts
  about the worktree, instead of being squeezed through the collector's
  shared error slot. The attention strip no longer carries this class of
  incident at all; it reflects true git-collector health only. (#429)
- The `git for-each-ref` failure path no longer emits a `collector.error` on
  every failing poll — it now follows the same threshold-and-latch shape as
  the dirty-status path, voicing once per incident. (#429)
- **The judge collector's two remaining throw/merge catches no longer re-voice
  every poll, forever (#526).** `extractLaneSymbols` failing for a lane, and
  `speculativeMergeTree` failing for a lane pair, both emitted a fresh
  `collector.error` on every single poll for as long as the same lane or pair
  kept failing (`#506`'s already-fixed heartbeat shape, applied to the two
  sites that were out of that issue's fence). Each now voices once when the
  incident opens and stays silent through repeats of the identical failure,
  re-arming silently on recovery so a later, genuinely new incident still
  voices.
- **A persistently-malformed row no longer re-voices every poll, forever (#506).**
  Four sites — workmux's status-row and list-row skip quarantines, its
  unrecognised-`agent.status`-value branch, and tmux's list-panes skip quarantine —
  emitted a fresh `collector.error` on every single poll for as long as the same bad
  row or line kept recurring (`#415`'s already-fixed heartbeat shape, not yet applied
  here). Each now voices once when the incident opens and stays silent through
  repeats of the identical row, re-arming silently on recovery so a later, genuinely
  new incident still voices. Also: a skip's rendered detail is now capped at 200
  characters instead of embedding an unbounded field (e.g. a very long agent title)
  verbatim into every occurrence of the message.
- **A worktree-root resolve that fails once no longer stays broken for the rest of
  the session (#505).** The subdirectory-join fallback added by #463 memoised
  `workdir → worktreePath` per pane/agent, but memoised a *failed* resolve
  (`null`) exactly the same as a successful one — a transient `git` failure, or a
  worktree removed and recreated under a parked pane, left `worktreePath: null`
  for the rest of the session with no way to recover short of a restart. Only a
  successful resolution is memoised now; a failure is retried on every later
  poll, in both the workmux and tmux collectors.
- **A pane parked in a worktree subdirectory on its very first poll now shows
  the right worktree path (#463).** `worktreePath` resolved only by joining
  `status`'s `workdir` against `list`'s `path` exactly; a pane whose workdir
  was already a subdirectory of its worktree (e.g. a pane that `cd`s into
  `packages/server`) never matched that join, and with no prior poll to carry
  a good value forward, `worktreePath` stayed `null` for the whole session.
  When `list` is otherwise healthy but the exact-path join misses,
  `worktreePath` is now resolved directly via `git rev-parse
  --show-toplevel`, memoised per workdir so a pane parked in the same
  subdirectory across polls only pays the extra `exec` once.
- **`withBranchReconciliation`'s "did this poll observe reality" signal is
  still inferred from allocation identity, but the snapshot shape it can be
  inferred from is now compiler-checked (#454).** The wrapper decided "not
  observed" from `branches`' reference identity — correct for `gitCollector`
  today (verified exhaustively, #449), but invisible to the compiler: the
  wrapper was generic over any snapshot with a `branches` field, so an
  unrelated future collector reusing it would get no warning if its own
  "nothing changed" fast path never allocated fresh. The wrapper's signature
  now names `GitSnapshot` concretely instead of a generic bound, so only a
  structurally-matching snapshot type-checks; an explicit "observed" marker
  the collector sets itself — the shape that would make the signal explicit
  rather than inferred — is deferred to a future migration. A poll that
  defies the identity contract without one of the two known failure events
  now surfaces a loud `collector.error` instead of silently skipping
  reconciliation forever.
- **A resumed session with a stale fold now retires ghost branches too
  (#449).** `withBranchReconciliation` (#139) diffed a resume's folded
  branches against reality correctly since #132-134, but was never wired into
  `loadCollectors` — a branch removed before #137 shipped, or while the git
  collector's own snapshot was stale, stayed in the fold forever, `NEED
  ATTENTION` banner and all. It is now applied to the git collector the same
  way `withAgentReconciliation` (#418) is applied to workmux, and carries the
  same one-shot-latch fix: a transient `git worktree list --porcelain`
  failure on the very first post-resume poll no longer burns the wrapper's
  only shot and mass-reports every folded branch as removed.
- **A failing dirty-status poll now voices one honest event per incident, not
  a heartbeat (#415).** Once `MAX_DIRTY_STATUS_FAILURES` (#241) was crossed,
  `git status --porcelain`'s `collector.error` re-fired on every subsequent
  failed poll, with the growing failure count baked into the message — never
  the same string twice, ~35 → 45 session-log lines in 10s. It now fires once,
  on the poll that crosses the bound, and stays silent through further
  failures; the counter resets silently on recovery so a later incident
  re-arms and voices again.
- **A removed workmux agent's lane stops rendering as healthy (#417).**
  `AgentState` gained `present`/`removedAt` in #306, but `findAgent()`
  (`selectors/worktrees.ts`) matched by path/branch/handle with no presence
  filter — unlike the worktree and pane joins beside it — so a departed
  agent's last-known status (`working`, `waiting`, …) stood forever even
  though the worktree itself was never removed. `findAgent` now filters on
  `present` first, the same way the worktree and pane selectors already do.
- **A resumed session with no workmux snapshot now retires its stale agents
  too (#418).** `agent.removed` (#306) only fires from a live poll's
  snapshot-to-snapshot diff; a session resumed with a missing or stale
  workmux snapshot had nothing to diff against, so a lane folded away before
  or during the restart stayed `present` for the rest of the session. The
  first live poll after resume now reconciles the fold's still-present
  handles against reality, the same way `withBranchReconciliation` (#139)
  retires a ghost branch. The reconciliation's one-shot latch no longer
  spends itself on a poll that failed transiently — a workmux hiccup on the
  very first post-resume tick used to burn the shot for nothing and leave the
  ghost `present` for the rest of the process; the wrapper now waits for a
  poll that actually observed reality before latching.
- **A departed workmux agent is now announced (#306).** `workmux status`
  failing for a reason other than a missing binary used to parse as an empty
  roster and drop every known agent with no event at all; a handle that
  genuinely left a healthy poll was never diffed against the previous roster
  either, so it also just stopped appearing. Both now read distinctly: a
  transient failure carries the roster forward and reports
  `collector.disabled` (letting the existing degraded/disabled ladder handle
  it), and a genuine departure emits the new `agent.removed` event —
  [ADR-0015](docs/adr/0015-agent-removed-is-an-event.md).
- **A deleted worktree now leaves the dashboard, instead of rendering as
  healthy forever (#241).** `git worktree list` never stops listing a
  worktree removed by hand outside rhizomorph, and the git collector's
  `git status` catch silently carried its last-known dirty-file set forward
  with no event. The collector now reads git's own `prunable` annotation
  (already parsed, already free) as proof a worktree is gone, drops it, and
  emits `worktree.removed`; a real transient failure still carries forward,
  but only for a bounded number of polls before it becomes a visible
  `collector.error` instead of stale silent data. Decision and rejected
  alternatives (including why the issue's own suggested ENOENT check would
  have been wrong) in
  [ADR-0016](docs/adr/0016-prunable-not-enoent-proves-a-worktree-gone.md).
- **A recovered collector's pill no longer sticks on `errored` forever (#304).**
  A collector that had failed and then recovered (`status: 'healthy'`) used to
  read `errored` in the provenance bar forever, with its last (stale) error
  message still shown on hover — the pill never got the self-heal news. It now
  reads `live`, silently, the moment `collector.recovered` folds.
- **C-quoted git paths round-trip (#237).** `git status --porcelain` C-quotes any
  path with a space or non-ASCII byte, and `git log --raw` quotes non-ASCII;
  both parsers took the quoted slice verbatim, so a file as ordinary as
  `my file.ts` reached the collision matrix as the literal `"my file.ts"` and
  matched nothing. Paths are now unquoted on parse and status renames split on
  the real arrow, not a ` -> ` inside a filename.
- **A tab in a tmux pane path, or one malformed `git log --raw` line, no
  longer kills the collector (#242).** `list-panes.ts` and `parse-log.ts`
  quarantine the one unparseable line — skipped, counted, and voiced as a
  `collector.error` — instead of throwing and losing the rest of that poll's
  events.
- **Three silent lane-identity gaps close (#243).** `workmux/collector.ts`
  joined `workmux list`'s rows by branch name but looked them up by handle,
  so a slashed branch (`feat/foo`) never matched and `branch`/`worktreePath`
  stayed `null` in every `agent.status` for that lane; the join now keys off
  the worktree directory name both commands actually share. `worktree-slug.ts`
  mapped only `/` and `_` to `-`, so a dotted worktree path resolved to a
  session directory that never existed and read as "no session yet" forever;
  it now maps `.` too, matching Claude Code's own transform. A detached HEAD
  on the *main* worktree silently degraded every branch's
  `aheadOfMain`/`behindMain` to `null`; the git collector now emits one
  `collector.error` naming the detached main worktree instead of staying
  quiet about it.
- **A rotated or truncated session log resumes being read (#305).**
  `sessionlog/tail.ts` treated "the file is now smaller than the offset we
  hold" the same as "no new bytes" and handed back the same stale offset
  forever, so a log truncated or rotated out from under the collector
  (log rotation, a fresh `claude` session reusing a path) went quiet with
  no error and never recovered short of a restart. The read cursor now
  resets to the start of the file whenever it shrinks below the held
  offset, so the next poll resumes reading normally. A same-path rotation
  whose replacement had already grown past the old offset by the next poll
  went undetected by size alone and read garbage from the middle of
  unrelated content; the cursor now also resets whenever the file's inode
  changes, so identity — not just size — decides when a poll is reading a
  different file.
- **A rotated session log no longer folds onto its predecessor's turn state
  (#366).** #305 made `sessionlog/tail.ts` reset the byte cursor on a
  same-path rotation, but the collector still resumed `turnShape`,
  `lastUsageRequestId`, lane, and branch from the file the rotation replaced
  — so the replacement's first lines folded onto a stale mid-turn shape, a
  coincidentally-repeated request id could suppress its own first usage
  block, and its liveness was misattributed until an assistant line
  happened to overwrite it. All four now reset to a fresh fold on a
  detected rotation instead of resuming the predecessor's.
- **A hung collector subprocess no longer freezes all polling or shutdown
  (#236).** Every collector exec now carries a default timeout, and a
  per-collector watchdog abandons a poll that exceeds its budget — surfacing
  a `collector.error` — so one wedged `git`/`tmux`/`workmux` child can no
  longer stall the other collectors or hang graceful shutdown. Decision and
  budget rationale in
  [ADR-0013](docs/adr/0013-collector-ticks-are-bounded.md) and
  [`docs/design-notes/collector-tick-budget.md`](docs/design-notes/collector-tick-budget.md).
  A bounded `git status` failure (including this new timeout) inside the
  dirty-file diff was carrying forward the last known state silently, with
  no `collector.error` — the one exec in the git collector that didn't
  already follow this PR's own "a timeout is a visible error, not silence"
  rule. It now reports one.
- **The replay scrubber glides (#270).** Its `step` was `max(1000, span /
  1000)` — about a thousand stops across any recording, so on an eight-hour
  session the thumb jumped between notches ~29 seconds apart with nothing
  between them reachable, and any session under a second was frozen on a
  single stop. The step is now sized to the rendered track instead: the
  session is cut into the smallest power of two notches at least as many as
  the track has pixels, so a notch is never wider than a pixel at any window
  size, and one arrow press still moves ~0.1% of the session. `end` stays a
  grid point at every width and every session length — including multi-day
  ones, where the step's exact quotient outgrows what the `step` attribute's
  shortest decimal can carry and the last notch would otherwise be
  unreachable. Native keyboard behaviour is untouched: this configures the
  range input, it does not reimplement it.
- **The provenance bar explains a boot another live instance forced,
  instead of going blank (#384).** `GET /api/meta` has reported
  `lastBootReason: 'writer-alive'` since #187 — a boot that started a fresh
  session because another rhizomorph still held the previous one — but the
  dashboard's own list of reasons it can explain never learned the word, so
  it discarded the whole response and rendered the session line as
  unavailable: the instrument saying "I don't know" about something it did
  know. It now says so, and points at `rhizomorph doctor` for the pid it
  cannot name itself. Nothing upstream could have caught this (the two
  lists are on opposite sides of a layering boundary neither can import
  across), so a seam test now reads both at runtime and fails on the next
  one.

- **Retargeting no longer shows the new repo's name over the old repo's
  fleet (#390).** The dashboard's live fold was never reset, so pointing it
  at another repository kept every worktree, branch, commit and spend fact
  of the previous one — under a heading that had already updated, which
  made the result a lie rather than a lag. The fold now drops what it has
  accumulated when a `session.started` names a different `repoPath`. An
  ordinary session rotation, and a reconnect that replays the same session
  from the top, both leave it alone. The lane manifest is re-asked at the
  same boundary: `/api/lanes` was previously fetched once for the life of
  the page, so the new repo's lanes were fenced, labelled and judged
  against the old repo's `.swarm/lanes.json`. The selected lane drops at
  the boundary too — a lane id belongs to the repo it was selected in, and
  names like `dev-1` and `main` recur across unrelated repositories.
- **Rename-in-place actually works (#249).** `POST /api/label` required a
  per-process capability token nothing ever delivered to the browser, so
  every rename in `/recordings` 401ed, on every boot. The server now
  stamps the token into `index.html`'s `<head>` at serve time and the
  dashboard reads it back — decision and threat-model consequences in
  [ADR-0012](docs/adr/0012-in-band-capability-token-delivery.md), the
  operator-facing account in [SECURITY.md](SECURITY.md#mutating-routes-and-the-capability-token).

## [0.1.0] - 2026-08-03

First published release. What the tool actually is, at this point:

### Added

- A live dashboard for a git-worktree agent swarm: point it at a repo
  (`npx rhizomorph <path>`) and it discovers worktrees and branches (git),
  agent panes (tmux), and [workmux](https://github.com/raine/workmux) state
  if present — each source optional, each degrading gracefully — and
  reflects reality within a couple of seconds via polling.
- **The scene**, a procedural, organism-like rendering of the fleet: one
  thread per lane, width and color carrying real signal (output volume,
  liveness, cost), pathologies (stalled, flatlined, collided) each drawn
  with their own unmistakable shape.
- **The fleet table**, the scene's tabular counterpart: every lane's
  handle, role, status, and cost, sortable and filterable.
- **Replay**: every session is recorded to a local, appendable event log
  and can be replayed afterward at the same fidelity it was watched live,
  scrubbing through exactly what happened.
- **The lane drawer**, opened per-lane, showing the agent's own
  conversation — the actual Claude Code session transcript for that lane —
  alongside its cost and timing.
- **`rhizomorph doctor`**, a read-only preflight that checks Node version,
  target path, web build, port availability, session logs, tmux/workmux,
  telemetry env, and the lane manifest — one `ok`/`warn`/`FAIL` line per
  check, each with its remedy.
- **`rhizomorph env <lane>`**, printing the exact environment block a lane
  needs to export OpenTelemetry cost/token telemetry to this instance's
  local OTLP receiver.
- Read-only and localhost-only throughout: no writes to the watched repo,
  no outbound network calls, nothing bound beyond `127.0.0.1`.
