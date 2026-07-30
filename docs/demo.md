# Demo script — end of day

Three acts: the Observatory watching its own construction live, then the
money layer, then replaying its own birth. All three run from the same
instance — no restart between them.

## Setup (before anyone's watching)

```sh
npm install
npm run build --workspace packages/web
npx observatory .        # from the repo root, so it watches this repo
```

Open the printed `http://127.0.0.1:4321` in a browser, full-screen it.

Leave the swarm's tmux/workmux session running in another window so the
collectors have live agents and worktrees to report on — the Observatory is
read-only and never touches it.

## Act 1 — live view of this repo's swarm

1. **Scene.** Point at the Three.js constellation at the top: each station is
   a worktree, pulses are commits landing, dimming stations are agents that
   have flatlined.
2. **Worktree table.** Branch, agent status, last activity, commits ahead of
   `main`, files touched — call out an agent mid-issue right now.
3. **Collision matrix.** Explain the glowing cell: two branches touching the
   same file before either has merged — this day's own failure mode, made
   visible ahead of the merge pain instead of after it.
4. **Commit ticker.** Let a real commit land during the demo if timing allows;
   otherwise narrate the most recent diffstat entries.
5. **Connection badge.** Point out it's SSE, not a refresh button — the
   dashboard is within ~2 seconds of ground truth the whole time, by polling,
   not filesystem watchers.

## Act 2 — the money layer

1. **Spend ticker panel.** Point at the live token/dollar total and the
   $/hour rate at the top — call out that it's tokens-only, with copy saying
   so, until a real `llm.cost` event has arrived from OTel; dollars are never
   invented from tokens.
2. **Role split + overhead ratio.** Worker / conductor / auxiliary tokens
   side by side, overhead ratio (conductor tokens ÷ worker tokens) picked out
   in magenta — prd1's headline number, the empirical price of the
   brain/hands principle, and the reason the conductor exports telemetry too
   instead of hiding off to the side of the count.
3. **Per-lane mini-bars and the worktree table.** Point at whichever lane is
   burning the most tokens right now, then the same numbers in the worktree
   table's **Cost** column and **Model** badge, per row.
4. **The honesty note.** Read the small print under the total out loud: on a
   subscription plan the number is real per-request but not a literal
   invoice line — the copy says so outright rather than let anyone read the
   ticker as a bill.

## Act 3 — the birth replay

1. In the replay bar at the bottom, hit **Replay this session's birth**. It
   picks the recorded session with the most history — sized by file, the best
   proxy available for event count — and jumps straight into playback of it,
   no picker required.
2. Bump the speed to **16x** to fast forward through the quiet stretches; that
   speed is what makes the long idle gaps between real events watchable
   instead of tedious — same reducer as live, just folding a history slice
   under the scrubber instead of a live stream.
3. Scrub by hand to a specific moment (e.g. the first `commit.landed` or the
   first collision) and pause there — the panel grid and scene both freeze to
   that instant, because replay and live share one reducer.
4. Point at the replay bar's own numbers while scrubbing: the whole loaded
   session's total spend next to the session picker, and spend "as of scrub
   time" below the scrubber — and at the spend ticker's per-lane rows, which
   keep pace live as you scrub, because replay folds the same reducer as the
   live stream, just under a scrubber clock instead of a live one. This is
   "what did that feature cost me", one click and a scrub away.
5. Hit **Return to live** to snap back to the present and close on the live
   view again.

If you'd rather choose by hand: the **session** dropdown next to the button
lists every recorded session, oldest first. Skip anything that shows as a
single `session.started` event with nothing after it — those are just short
server restarts, and a normal recordings directory accumulates several of
them, which is exactly why "richest" beats "oldest" for the one-click path.

## If something degrades

- No workmux installed: one `collector.disabled` event, agent-status panel
  goes quiet, everything else keeps working — say so out loud, it's the
  point.
- The scene errors: the error boundary drops it, panel grid stands alone,
  demo continues uninterrupted.
- Nothing has committed recently: fall back to narrating the worktree table's
  "files touched" and the collision matrix, which update on uncommitted dirty
  state, not just commits.
- No telemetry env set on any lane: the spend ticker shows "No spend recorded
  yet this session," and no cost telemetry at all (env set, but OTel hasn't
  sent a cost datapoint yet) shows tokens with the tokens-only honesty copy —
  say so out loud, same empty-state discipline as every other panel.
