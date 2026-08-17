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

---

## Ruling 2 amended — the hero is the fleet SURFACE, and its size is a share, not a floor (walkthrough, 2026-08-17)

**What ruling 2 said:** *"The screen answers 'what is the fleet doing?'
first. The scene is the centerpiece: big, bright, self-explanatory,
directly under the attention/burn dock. The fleet table and detail panels
move below as reference instruments."*

**What a human found on the running instrument, at 164 lanes:** the fleet
showed three rows.

### The half of the ruling that survives

The **question order** stands, and is not reopened. *Who is alive* is the
first-second question, it is answered above everything else, and it gets
the largest share of the screen. Nothing below narrows that.

### The half that is false, and why it had to be amended rather than styled around

Ruling 2's justification for giving the slot to *the scene specifically*
was that it is **"self-explanatory"**. That is true of eight lanes and
false of a hundred and sixty-four, and the PRD that first said so knew it
would be: prd-36's own problem statement is that the canvas "cannot be
searched, copied, screen-read, or rendered usefully at forty lanes
without becoming a hairball", and prd-36 ruling 1 already replaced the
mechanism — one surface, two representations, **the list is the floor**.

So ruling 2's *conclusion* had already been superseded in code while its
*sentence* went on justifying a layout decision that no longer matched it.
That mismatch was the bug, mechanically:

- the scene carried `min-h-[55vh]` — a floor **nothing else on the page
  had**, granted to it on the strength of "self-explanatory";
- every sibling in the panel column was freely shrinkable, so all the
  pressure landed on the roster;
- and the roster's `overflow-auto` **clipped silently** rather than
  pushing back, so the instrument lost 161 of 164 lanes without saying a
  word — a failure of law 12 hiding inside a layout rule.

### The amendment

1. **The hero slot belongs to the fleet SURFACE, not to the scene.** The
   scene is one of its two representations (prd-36 ruling 1); the list is
   the other and is the floor. Whichever is up, the surface is the
   centerpiece.
2. **Its size is a proportion of the viewport, never a `min-height` floor
   on one representation.** `PanelGrid` divides its row into
   `minmax(0, 3fr)` for the fleet and `minmax(0, 2fr)` for the dock, and
   `Shell`'s middle row is `minmax(0, 1fr)` so it takes what the docked
   `auto` rows leave rather than being squeezed by them. 3:2 is this
   ruling's hierarchy expressed as height.
3. **The page does not scroll; the panels do.** A share a panel cannot
   fill scrolls inside itself, so nothing is ever below a fold — because
   there is no fold. A floor that pushes a sibling off-screen and a
   scroll container that clips it are the same failure wearing two faces,
   and both are gone.
4. **A representation may never be granted room another cannot have.** The
   `min-h-[55vh]` is deleted rather than moved: a floor on the canvas is
   a floor the roster does not get, which is exactly how the roster came
   to be the thing that shrank.

**What is deliberately given up, named so nobody re-adds it by accident:**
the guaranteed 55vh of canvas. On a short window the scene is now smaller
than prd4 shipped it. That is the trade this amendment makes on purpose —
the art may be as expensive and as large as the viewport allows, and
navigation does not depend on it (prd-36 ruling 1).

**Rulings this does NOT touch:** the layman bar (1), law 9a/9b (3), the
CLI-style conversation (4 — superseded separately by prd-36 ruling 2's
peek, which moved it to the run view), parked-is-a-state (5).
