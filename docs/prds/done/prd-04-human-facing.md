# prd4 — the instrument turns human-facing

> **Outcome:** superseded by what actually shipped — see `docs/roadmap.md`.

prd3 delivered the instrument; the operator's review (2026-08-01) found it
fails the **layman bar**. This prd re-aims the surface at humans. Rulings
from the design interview, operator, 2026-08-01:

## Rulings

1. **The layman bar (standing ruling).** A first-time viewer — layman,
   even though the product targets developers — should understand what is
   going on, what things mean, and what to do next. Every prd4 issue is
   accepted against this bar, and ruling 25's SCENE/GLANCE legs are
   re-run under it with a lay viewer explicitly invited.
2. **The screen answers "what is the fleet doing?" first.** The scene is
   the centerpiece: big, bright, self-explanatory, directly under the
   attention/burn dock. The fleet table and detail panels move below as
   reference instruments. (Amends prd3 ruling 6's curated order.)
3. **Ruling 29 amended — activity state gets real color.** Law 9 splits:
   - *Law 9a — hue is meaning, and each hue means one thing.* Green =
     productive, amber = blocked on a human, red = dead, cyan =
     notice/anomaly, ice = structure and nothing-to-say. Red only ever
     means broken. The ladder and activity states merge into one semantic
     scale: needs-you is the incandescent end of the amber family, benign
     waiting its muted end — severity told by brightness, glow and
     enclosure, as everywhere else.
   - *Law 9b — the brightness band and alarm grammar own attention, not
     hue exclusivity.* Full-strength rung color and alarm treatments
     appear only on alarm marks; calm marks may wear family hues below
     the calm ceiling.
   - The "too dark/pale" complaint is pinned mechanically: a new
     `CALM_FLOOR` law (minimum calm-thread brightness) makes the regression
     untestable-in rather than re-findable.
4. **Chat mirrors the CLI experience.** Clicking a lane shows what you
   would see using a claude/codex agent: the conversation itself —
   user/assistant turns with quiet tool-call bullets between —
   chronological, tail-following, the drawer's default and largest
   section. (Supersedes the transcript-collapsed-by-default ruling in
   prd3 #84.)
5. **Parked is a state, not a mute.** The three prd3 spike worktrees are
   retired (tagged, worktrees removed, branches deleted — history keeps
   everything). Product: `.swarm/lanes.json` entries gain
   `parked: true` — an operator declaration in the manifest, never
   written by the read-only instrument. Parked lanes render dimmed
   `PARKED`, visible and never hidden, exempt from FROZEN/WAITING
   inference, skipped by the ladder. An instrument acknowledges; it does
   not silence.

## Implementation waves (issues #92–#96)

Wave 1: **#92** activity-state palette keystone (opus — theme tokens,
scene palette/budget, sigils, table legend) ∥ **#94** CLI-style
conversation (opus — structured transcript + drawer rebuild). Wave 2,
after #92: **#93** scene-centerpiece layout · **#95** parked state.
Wave 3: **#96** docs/demo refresh. Conductor verification per wave in a
real browser; gates run the bounded busy-box standard (prd3 rulings
33–34).
