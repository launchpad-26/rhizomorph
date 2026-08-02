# Prior art: human-facing orientation in many-agents-at-once UIs

**Date:** 2026-08-01 · **For:** Rhizomorph prd5 grooming · **Method:** WebSearch/WebFetch, claims graded [Verified] (primary fetched), [Consensus] (multiple/secondary sources), [Thin] (single weak source).

**Decision:** groom prd5 orientation/polish issues — the field has solved pieces of this (RTS solved orientation, observability solved rollup/drill-down, aviation solved status color, mission control solved the register), but no agent GUI yet combines them; the steal-list below is the shortest path to "not just a tool."

---

## Steal-list (ranked)

1. **Idle-worker button** (StarCraft II) — a persistent counter above the minimap showing units that need orders; one keypress (F1) jumps to the next one. [Consensus — Liquipedia, Blizzard Game Guide] → Rhizomorph: the attention strip should have a "N agents need you" pill with a hotkey that cycles to the next amber/red agent. This is the single highest-value transfer.
2. **Control groups + double-tap recall** (SC2) — Ctrl+number binds a group; pressing recalls selection, double-tap centers the camera. [Consensus — Blizzard Game Guide] → number keys select an agent lane; double-tap focuses/zooms it.
3. **Minimap + alert ping doctrine** (RTS genre) — a spatially stable overview where events flash in place and clicking jumps the camera there. [Consensus] → the attention strip should be spatial (stable per-agent positions), with pings that flash then fade to a persistent dot until acknowledged.
4. **Strategic zoom / sensors manager** (Supreme Commander; Homeworld) — SupCom zooms "smoothly and continuously" from single unit to whole theater [Consensus]; Homeworld's Sensors Manager is a separate strategic view with **icon amalgamation** — nearby units collapse into one icon at distance [Consensus — Steam/GameFAQs]. → one continuous zoom between root-mass overview and single-thread detail beats modal view-switching; amalgamate lanes when N is large.
5. **Inverted-pyramid hierarchy** (Grafana) — organize "large to small, general to specific"; key rollup top-left (Z-scan pattern); drill-downs via parameterized dashboards, not copies; dashboards must "reduce cognitive load, not add to it." [Verified — grafana.com best-practices doc, fetched 2026-08-01]
6. **Regulated status color** (aviation/FAA) — red = warning (act now), amber/yellow = caution (timely action), green = normal; color exists for "attention, identification, and segmentation," never decoration. [Consensus — FAA HF guidance ch. 3.7; Applied Avionics color guide] → Rhizomorph's green/amber/red already matches the standard; enforce that nothing else on screen uses those hues.
7. **"What's different" drill-down** (Honeycomb BubbleUp / core analysis loop) — select the anomaly, system compares inside-the-box vs baseline and sorts by difference. [Consensus — honeycomb.io/platform/bubbleup, docs.honeycomb.io] → clicking a red agent should immediately answer "what changed" (last tool call, last error), not just open a transcript.
8. **Single-keystroke contextual verbs** (k9s) — cursor on a resource, then `l` logs, `d` describe, `s` shell; real-time refresh; "faster than any monitoring dashboard because you're already in the terminal." [Consensus — k9scli.io + multiple writeups] → with an agent selected: one key for transcript, one for diff, one for interrupt.
9. **Unit portrait / selection panel** (SC2 + RTS genre) — selecting a unit shows portrait, health, current command, and queue in a fixed panel. [Consensus] → the conversation drawer is the selection panel: fixed position, shows identity, current task, command queue; never a floating window per agent.
10. **Composable live objects, one environment** (NASA MCT) — "commands and telemetry are composed, so no context switching between software packages is required"; user objects (a telemetry value, a procedure step, a timeline) are live and editable in place. [Verified — NTRS 20110010878, Trimble & Crocker, AIAA; PDF read 2026-08-01] → conversation, diff, and telemetry for one agent belong in one composed surface.
11. **Kanban of sessions, agent-first** (Devin Desktop "Agent Command Center"; Vibe Kanban) — sessions as cards with status/PR-readiness; "the Agent Command Center is what you see first, and code comes second." [Thin — secondary posts (the-agent-report.com, productcool.com); docs.devin.ai not fetched] [Consensus for Vibe Kanban — vibe-kb.com]
12. **Broadcast history** (EVE Online fleet window) — fleet members broadcast discrete requests ("need armor," "target X") into a shared, append-only tab. [Consensus — EVE University wiki] → agents' "I need input" events should accumulate in an inspectable log, not just vanish after being handled.

---

## Domain findings

### 1. Agent-orchestration GUIs

- **LangGraph Studio**: renders the agent graph live, streams "real-time information about what steps are happening," supports step-through debug mode, interrupts, and forking a thread from any checkpoint. [Verified — langchain.com blog, fetched 2026-08-01] It is single-agent-debug-first: superb for *why did it do that*, weak for *which of my 12 agents needs me*.
- **AutoGen Studio** (Microsoft): playground view with "real-time agent updates," message-flow visualization, mid-execution control (pause, redirect), and a profiler for per-agent metrics. [Consensus — microsoft.com research blog/paper via search] Same shape: one session under a microscope.
- **Rivet** (Ironclad): remote debugger attaches to your running app and shows data flowing through the prompt graph live. [Consensus — ironcladapp.com blog] **Flowise**: authoring canvas, "limited" live debugging. [Consensus] Both are *builder* canvases — topology-first, not status-first.
- **Devin**: parallel sessions (secondary sources say up to 10) each in its own VM; Devin Desktop adds a Kanban command center with session status and PR-readiness. [Thin — secondary coverage only]
- **Cursor 2.0**: "a new editor, with a sidebar for your agents and plans"; up to 8 parallel agents on one prompt via worktrees/remote machines; aggregated multi-file review "without needing to jump between individual files." Changelog is silent on status indicators or attention flags. [Verified — cursor.com/changelog/2-0, fetched 2026-08-01]
- **Conductor** (Claude-fleet Mac app): workspaces list, one isolated worktree per agent; pitch is literally "See at a glance what they're working on," then "review and merge their changes." [Verified — conductor.build, fetched 2026-08-01] Their guidance that 3–5 parallel workspaces is the human ceiling is secondary reporting. [Thin — codepick.dev]
- **OpenHands**: agent pauses in an explicit `WAITING_FOR_CONFIRMATION` state until the user approves/rejects; Agent Canvas connects to multiple agent servers and flips between them. [Consensus — arxiv 2511.03690, docs.openhands.dev]
- **Pattern across all of them**: conversation transcript is the primary surface, telemetry is bolted on; none has a genre-standard answer to glanceable fleet status — that's the open lane Rhizomorph is driving into. [Consensus]

### 2. Observability / fleet dashboards

- Grafana: visual hierarchy, Z-pattern top-left priority, meaningful color via thresholds, drill-down over sprawl, "tell a story." [Verified — grafana.com docs, fetched 2026-08-01]
- Honeycomb: "core analysis loop" — notice anomaly → BubbleUp compares anomaly vs baseline → sorted differences tell you where to look. [Consensus — docs.honeycomb.io]
- k9s: keyboard-first, live-refresh, verbs-on-selection; beloved precisely because triage speed beats dashboard polish. [Consensus]
- Incident/SOC UX literature: correlate related events into one incident; show the "critical few"; tailor views by role (analyst vs exec); explain *why* an alert matters inline. [Consensus — Rootly, aufaitUX, LogicMonitor et al.]

### 3. RTS / fleet-command idioms

Covered in steal-list items 1–4, 9, 12. Explicit transferable idioms: **idle-worker counter**, **control groups + camera recall**, **minimap pings**, **strategic zoom**, **icon amalgamation**, **selection panel with command queue**, **fleet broadcasts**, plus **Tab-cycling subgroups within a selection** (SC2) [Consensus — Liquipedia] → within a selected wave, Tab cycles member agents. Homeworld players run the Sensors Manager on a second monitor when they can [Consensus — Steam discussions] — evidence that overview and detail want simultaneous, not alternating, screen space.

### 4. Mission-control register

- The look: bright color-coded telemetry channels on near-black plot fields (MCT's ISS telemetry screens show exactly this — yellow/cyan channel labels on black). [Verified — NTRS 20110010878 Fig. 2]
- Why dark: control-room guidance optimizes contrast with "dark backgrounds and bright characters" under low ambient light; but 1967 MCC human-factors work warns that *many* bright symbols on black "dazzles and confuses" — dark themes only stay serious when luminous elements are rationed. [Consensus — Extron control-room guide; Hendrickson 1967, Information Display] That ration is the "glow discipline": glow = status, never chrome.
- Why it reads serious: consistent object behavior ("the interface does what a user familiar with the domain would expect"), one unified environment, density with strict semantics — not decoration. [Verified — NTRS 20110010878] Typography guidance exists in NASA flight-deck documentation research (case, character height, spacing as legibility variables). [Thin — NTRS 19930010781, not fetched]
- Control-room layout standard is ISO 11064. [Consensus]

---

## What to avoid

- **Graph-canvas-first layout** (LangGraph/Flowise/Rivet): topology answers "how is this wired," not "what needs me now." Keep any DAG view as drill-down, never home. [Consensus]
- **One view doing everything**: EVE players learn one overview window "fails when pressure hits" — separate hot data (broken/waiting) from warm data (transcripts, progress). [Thin — eveexplorer.com; directionally backed by EVE Uni multi-overview docs]
- **Transcript as home surface**: every agent GUI does this; it's the anti-glanceable default. Transcript belongs in the drawer (selection panel).
- **Dashboard sprawl / copied variants** (Grafana's warning): parameterize one lane view, don't fork per-agent layouts. [Verified — grafana.com]
- **Alert fatigue**: undifferentiated event streams bury the critical few; correlate, prioritize, and explain-why inline. [Consensus]
- **Decorative status hues**: if amber/red/green appear anywhere non-semantic, the status board loses authority. [Consensus — FAA color guidance]
- **Too many bright elements on dark**: the 1967 dazzle warning; cap simultaneous glow. [Consensus]

## Open questions

- What N breaks the lane metaphor? Conductor's reported 3–5 human ceiling vs Devin's 10 sessions — does Rhizomorph need icon amalgamation/clustering above ~8 lanes? [Thin evidence either way]
- Should amber escalate with age? Urgency-based color-coding research for multi-UAV supervision exists (ScienceDirect, not fetched) — worth a read before styling the waiting state.
- Audio pings: RTS orientation leans heavily on sound; does Rhizomorph want an opt-in audio channel for red events?
- Keyboard-first (k9s register) vs mouse-first: which is the drawer's primary mode, and do control-group hotkeys conflict with terminal focus?
- Broadcast log (steal #12): separate surface or a filter on the attention strip?

## Sources (all accessed 2026-08-01)

- Grafana best practices — https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/ (fetched)
- LangGraph Studio announcement — https://www.langchain.com/blog/langgraph-studio-the-first-agent-ide (fetched)
- Conductor — https://www.conductor.build/ (fetched); docs https://www.conductor.build/docs
- Cursor 2.0 changelog — https://cursor.com/changelog/2-0 (fetched)
- NASA MCT paper (Trimble & Crocker) — https://ntrs.nasa.gov/api/citations/20110010878/downloads/20110010878.pdf (fetched, pp.1–8 read)
- AutoGen Studio — https://www.microsoft.com/en-us/research/blog/introducing-autogen-studio-a-low-code-interface-for-building-multi-agent-workflows/ ; https://microsoft.github.io/autogen/0.2/blog/2023/12/01/AutoGenStudio/
- Rivet — https://rivet.ironcladapp.com/ ; https://ironcladapp.com/blog/meet-rivet/
- OpenHands SDK paper — https://arxiv.org/html/2511.03690v1 ; docs https://docs.openhands.dev/
- Devin Desktop (secondary) — https://the-agent-report.com/2026/06/cognition-devin-desktop-agent-orchestration/ ; https://docs.devin.ai/release-notes/2026
- Vibe Kanban — https://vibe-kb.com/ ; orchestrator roundup https://github.com/andyrewlee/awesome-agent-orchestrators
- k9s — https://k9scli.io/
- Honeycomb BubbleUp / core analysis loop — https://www.honeycomb.io/platform/bubbleup ; https://docs.honeycomb.io/get-started/basics/observability/concepts/core-analysis-loop
- SC2 idle worker / control groups — https://liquipedia.net/starcraft2/Unit_Shortcut_Tricks ; https://news.blizzard.com/en-us/article/4552955/game-guide-special-control
- Homeworld Sensors Manager — https://steamcommunity.com/app/244160/discussions/0/617328415074104334/ ; https://gamefaqs.gamespot.com/pc/533091-homeworld-2/faqs/43499
- EVE overview/fleet — https://wiki.eveuniversity.org/Fleet_interface ; https://eveexplorer.com/eve-overview-2026/
- FAA color guidance ch.3.7 — https://hfcc.dot.gov/publications/docs/GeneralGuidance/zz_FAA_GeneralGuidanceDoc_Chapter_03_Section_07.pdf ; Applied Avionics https://www.appliedavionics.com/techguides/Content/TG-LPBS-21/1.3.1_Aviation%20Colors.htm
- Control-room human factors — https://www.extron.com/article/environconhumanfact ; Hendrickson 1967 https://sid.onlinelibrary.wiley.com/doi/full/10.1002/j.2637-496X.1967.tb01263.x ; incident-UX https://rootly.com/sre/beat-alert-fatigue-ai-triage-faster-incident-response
