# Product, docs, and vision review

**Reviewer:** `gpt-5.6-sol`, `xhigh` — product/docs/vision agent  
**Date:** 2026-08-06  
**Scope:** product proposition, audience, UX, README, vision, roadmap, PRDs, user
guides, release story, trust claims, and product direction

## Verdict

Rhizomorph has a genuinely differentiated core: a local attention radar and flight
recorder for an operator running parallel coding agents. The visual identity is
memorable, the operational questions are real, and the project's “gap voice” principle
is excellent product judgment: unavailable evidence is named with cause and remedy
rather than rendered as zero or silence.

The largest risk is coherence. In roughly a week the project expanded from a read-only
observatory into a recorder, portable evidence format, provenance system, and experiment
launcher. The vision, trust model, release story, and user guides still describe earlier
versions. The documentation now reads more like an archaeological record of how the
system was built than a reliable account of what exists today.

## What is strong

- The primary job is crisp: glance at a second monitor and know whether anything in the
  fleet needs attention (`docs/prd3.md:8-24`).
- “Gap voice” is a strong product principle. Missing telemetry, manifests, attribution,
  or evidence is explained rather than silently guessed (`docs/prd3.md:67`).
- Live and replay sharing one event-sourced reducer gives replay genuine integrity
  rather than making it a visual simulation (`docs/architecture.md:139`).
- The project is willing to cut attractive work after operator use. Removing the TIDE
  density band after repeated affordance attempts remained noisy is especially good
  judgment (`docs/prd13.md:91`).
- `doctor`, graceful collector degradation, portable records, explicit provenance, and
  measured performance claims are unusually good trust-building features.
- The visual scene is differentiated and generally tied to defined operational
  questions rather than defended as decoration.

## Critical product-truth failures

### The trust documentation no longer describes the product

The README, Security document, and Lab guide say the laboratory is reachable only from
the CLI and never from a server route or UI:

- `README.md:212-218`
- `SECURITY.md:16-22`
- `docs/user-guide/the-lab.md:3-7`

The shipped product mounts a Lab page, sends `POST /api/lab/launch`, and dispatches
experiment arms from the browser:

- `packages/web/src/lab/LabPage.tsx:236-267`
- `packages/web/src/lab/launch/launch.ts:108-118`
- `packages/server/src/api/lab.ts:507-547`

This is particularly damaging because Trust is deliberately positioned as the second
thing a prospective user should read. The observer/recorder/laboratory vocabulary is
useful, but those capabilities now share one server and UI. Claims should be expressed
in terms of concrete authority and invocation boundaries, not broad component names.

The absolute outbound-network wording is also misleading for the product as a whole.
Laboratory forks run `npm install`, which may reach a registry and execute lifecycle
scripts, while the README says there is no outbound call anywhere in the codebase.

### Release truth is contradictory

The README says there is no published package and that `npx rhizomorph` returns 404
(`README.md:25-27,71-93`). `CHANGELOG.md:102` calls 0.1.0 the first published release and
documents `npx rhizomorph <path>` as the installation route.

For a project whose public launch is explicitly blocked on a repository-history
decision, this makes every other status claim harder to trust. There should be one
source of current release truth shared by README, changelog, and CLI.

## Product coherence and scope

The vision says Rhizomorph is never a conductor: it launches nothing and decides
nothing (`docs/vision.md:28-34`). The package description still markets it as read-only.
That is a strong description of the original observatory, but not of a product that now
records, rotates, labels, exports, creates Git objects and worktrees, starts experiment
arms, and incurs spend.

There are at least four products under one name:

1. Live attention and cost observability.
2. Session recording, replay, and portable evidence.
3. Causal investigation and provenance.
4. Experimental forking, launching, and comparison.

They can form a coherent loop, but no current document explains that loop or declares
which capability is the flagship. The strongest wedge remains the local, read-only
attention radar and flight recorder. The laboratory should be visibly beta and
secondary until its trust boundary, spend controls, and post-launch workflow mature.

## Roadmap and validation

`docs/roadmap.md` is a detailed PRD ledger, including superseded slots and implementation
history, rather than an outcome-led roadmap. Most product evidence comes from one
operator, one JV conversation, a prospective cohort, and internal review exercises.

The explicitly strongest user pain — “what did my swarm do while I was away?” — remains
an unbuilt candidate while many rounds went into procedural form, animation, replay
chrome, and laboratory expansion (`docs/roadmap.md:25-32,147-165`).

Missing product measures include:

- Time from an agent needing attention to operator action.
- Collisions detected before merge.
- Time required to reconstruct a session.
- Cost anomalies caught.
- Percentage of recordings revisited or shared.
- First-run activation and repeat use.

Create a one-page current strategy naming the target segment, primary job, alternatives,
key assumptions, and three to five outcome measures. Move feature history to an archive.

## Audience and compatibility

The intended audience shifts among the builder, “anyone,” a junior cohort, an operator
running a second-monitor Workmux fleet, and eventually users of any OS, terminal, agent
CLI, or provider. The valuable experience is still Claude-centric; Codex/pi adapters,
multi-orchestrator support, and Windows-native verification remain unshipped.

The first release should be positioned honestly for individual or small-team power users
running parallel Claude Code agents in Git worktrees, especially with tmux/Workmux.
Other CLIs should remain roadmap adapters until one is working end to end.

## Onboarding and UX

The supported installation is a clone plus `npm install`, which does not normally place
the bare `rhizomorph` executable on an interactive shell's PATH. Yet guides and UI
remedies repeatedly instruct users to type `rhizomorph rotate`, `rhizomorph sessions`,
`rhizomorph env`, and `rhizomorph lab ...`. Pick one clone-safe syntax such as
`npm exec rhizomorph -- ...` and test every documented remedy.

The five-minute guide culminates in an empty scene, empty table, zero lanes, and no cost
feed (`docs/user-guide/getting-started.md:113-133`). Rich fixture modes already exist but
are hidden behind keyboard shortcuts. Put a visible “Explore a sample fleet” action in
the empty state and onboarding. `ALL CLEAR` should also require actual coverage; zero
monitored lanes should read as “nothing monitored yet.”

The Lab launch permits confirmation when spend cannot be estimated, allows arbitrarily
many arms, and does not refresh the experiment listing after launch. Label the Lab beta,
cap arms initially, require explicit acknowledgement when an estimate is unavailable,
and refresh the page's experiment state after completion.

## Documentation architecture

The architecture document explicitly appends decisions rather than rewriting current
truth (`docs/architecture.md:3`). That is appropriate for a decision log, not a current
architecture reference. The result includes:

- A roughly 790-line README duplicating user guides, issue history, rulings, screenshots,
  and implementation notes.
- A roughly 2,400-line architecture document beginning with obsolete event and route
  inventories.
- PRD14 simultaneously ruling free-form arms and describing them as deferred.
- The Lab guide describing launching, branching, comparison, and primary navigation as
  unshipped after they landed.
- README describing macOS as unverified while CI runs macOS suites and package smoke
  tests.
- README claiming 3,158 tests while the current suite contains 3,412.

Split current truth from history:

- Short README.
- Current product and compatibility page.
- Current architecture and threat model.
- Task-oriented user guide.
- Immutable PRD/history archive.
- ADRs for durable decisions.
- Generated feature/route/CLI status inventory.

Add link checks, command-snippet tests, screenshot freshness checks, and current-route
documentation checks to CI.

## Privacy and lifecycle UX

Recording is always enabled; transcripts are copied on close; deletion and retention
controls are absent. Conversations can contain source, credentials, customer data, and
proprietary context even after identity/path redaction. Export makes the record portable
with minimal warning.

Before public distribution, add:

- First-run disclosure of what is read and persisted.
- An ephemeral or `--no-record` mode.
- Retention by size and age plus a safe deletion flow.
- Export preview and confirmation naming included transcripts.
- A share-safe export profile and a redaction report.

## Recommended product direction

1. Preserve the wedge: local attention radar and flight recorder for parallel agents.
2. Make first-run value immediate with a visible sample fleet and replay.
3. Correct trust and release truth before public distribution.
4. Validate the catch-up brief with several real operators.
5. Keep Lab secondary/beta until security, spend controls, and workflow are complete.
6. Delay “any CLI / any OS” positioning until real non-Claude and Windows evidence
   exists.
7. Replace PRD archaeology with a concise strategy and outcome-led roadmap.
