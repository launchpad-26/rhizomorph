# prd13 — the TIDE: the scrubber grows a body

The dashboard-IA spike (`docs/research/2026-08-04-dashboard-ia-spike.md`) found
that our weakest control is the one that navigates time: `Scrubber.tsx` is a
bare `<input type=range>`, so **you scrub blind**. Its verdict was that a
state-timeline is the highest-value single addition to the layout — but only
if it is framed as *the scrubber grew a body*, never as a panel. As a panel it
competes with the scene for the scene's own job, and the scene is the market
thesis.

The spike closed with five open questions and an admission that no browser
probe had been run. Both were answered on 2026-08-04: the operator ruled, and
the felt-evidence pass against a live Grafana state timeline is recorded in
the spike's own "Felt evidence" section. Every ruling below is grounded in one
or the other.

## Ruling 1 — the TIDE is the replay bar's body, never a panel

The swim-lane docks directly above the transport so they share one x-axis and
read as a single TIME dock. **Zero rows are added to the curated order, the
scene's hero status (prd4 ruling 2) is untouched, no new hue appears, and no
new motion class is introduced.** If a future round is ever tempted to promote
the TIDE to a panel of its own, that is the moment it starts competing with
the scene — the answer is no.

## Further rulings

2. **Live shows session-to-now compression.** The whole session is squeezed
   into the bar, so the playhead's position carries absolute meaning and the
   band *is* the recording's map. This is the navigation reading, deliberately
   chosen over a rolling 30m monitoring window: the TIDE's job is to make time
   legible, not to answer "what is happening now" — the attention strip, burn
   strip and scene already do that. As a session grows, early detail
   compresses; that is accepted, and the fix is zoom (ruling 5), not a
   different window.
3. **Lane rows are stable for the session.** A lane keeps its row for as long
   as the session lasts, so it can be learned and pointed at — graft g7's
   pointability argument applied to y instead of θ. Sorting by attention was
   explicitly rejected: rows that move under the cursor destroy the muscle
   memory that makes a timeline scannable. Urgency is already answered twice
   above the fold, in words by the attention strip and in shape by the scene.
4. **Density is bought by coalescing, never by stacking.** 14px rows, top-N by
   attention, remainder coalesced into a `+N` row carrying its count — the
   existing coalescing law on a new surface, not a new law. Live renders
   collapsed to one merged band; replay and an explicit expand give per-lane
   rows. **Stacked area of lanes is forbidden** (Grafana's own best practice
   warns it hides data): bands per lane, never summed. Sub-pixel slivers are a
   measured failure mode — in Grafana's dense panel they are unhoverable and
   unreadable [Ran] — so a band below the hover threshold must coalesce rather
   than render.
5. **Zoom drives everything, but only opt-in, and says so.** Dragging a
   selection moves the playhead and nothing else by default. A deliberate
   "scope to selection" control makes the other surfaces follow, and while
   scoped **the dashboard visibly declares it** and every windowed figure
   labels itself. This is a law-12 ruling made on witnessed evidence: in
   Grafana, one drag silently rewrote every panel on the page — the ledger
   equivalent showed different numbers with nothing but a distant time picker
   to say why [Ran]. A total that has quietly become a window is exactly the
   dishonesty law 12 exists to forbid.
6. **Duration is a first-class fact, not a derived one.** The hover reads
   `start – end · lane · STATE · Duration 1h 20m`, stolen deliberately from
   Grafana's tooltip shape [Ran]. Three of prd3 ruling 18's five pathologies
   are duration facts: FROZEN is a long unbroken band, LOOPING a fast
   repeating stripe, and WAITING an amber band **whose length is the insult**.
   The number must be readable, not inferred from pixel width.
7. **Labels when they fit; colour when they do not; a legend never.** Where a
   band is wide enough it carries its state as text, so the surface is
   self-legending. Where it is not, colour alone carries it — and we do *not*
   grow a per-panel legend, which is Grafana's answer and the crutch this
   project has already ruled against. Our escape is structural: the ladder
   hues are taught by the fleet table ("the fleet table teaches it, the scene
   speaks it"), so a colour-only band inherits a legend that already exists on
   the page.
8. **No-data is a hatch, not a state.** A gap in coverage renders as an
   explicit hatch that reads as absence, never as a fill that could be mistaken
   for a state — the honest-gaps law restated on a new surface. An
   uninstrumented lane must not look like an idle one.
9. **The window is deep-linkable.** A scoped range lives in the URL the way
   Grafana's does [Ran], so a window is shareable and survives reload — and it
   composes with `/lane/:handle` (#135) rather than forking a second router.
10. **The transport gains the affordances it lacks**: an explicit zoom-out and
    window-shift, alongside the playhead. The bare range input keeps its native
    keyboard behaviour (arrows, Home/End, PageUp/Down) by construction, as
    ruling 16 of prd10 already requires — the body is added around it, not in
    place of it.
11. **The burn strip's fifth and sixth number are settled and not reopened.**
    #159 landed the errors figure and declined latency ("errors yes, latency
    no", recorded in `packages/web/src/panels/burn/format.ts`). The spike's
    first open question is closed.

## Sequencing

The TIDE is worth roughly what the spike's cheap wins were worth *combined*,
and those shipped first as #159. It depends on **#162** (the surviving replay
re-fold — scrubbing must be responsive before a scrubbing surface is worth
building) and sits alongside **#163** (the drawer relayout). Land the TIDE
whole rather than half: a swim-lane without its duration hover, or with a
legend bolted on, is the version the spike warned about.
