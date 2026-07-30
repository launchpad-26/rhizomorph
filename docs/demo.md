# Demo script — end of day

Two acts: the Observatory watching its own construction live, then replaying
its own birth. Both run from the same instance — no restart between them.

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

## Act 2 — the birth replay

1. In the replay bar at the bottom, open the session picker — it lists every
   recorded session for this repo, oldest first.
2. Select the **first** entry: the session that started the moment
   `observatory` first ran against this repo, `session.started` event zero.
3. Hit **Play** at a low speed first (1x), then bump to a higher speed to fast
   forward through the quiet stretches — same reducer as live, just folding a
   history slice under the scrubber instead of a live stream.
4. Scrub by hand to a specific moment (e.g. the first `commit.landed` or the
   first collision) and pause there — the panel grid and scene both freeze to
   that instant, because replay and live share one reducer.
5. Hit **Return to live** to snap back to the present and close on the live
   view again.

## If something degrades

- No workmux installed: one `collector.disabled` event, agent-status panel
  goes quiet, everything else keeps working — say so out loud, it's the
  point.
- The scene errors: the error boundary drops it, panel grid stands alone,
  demo continues uninterrupted.
- Nothing has committed recently: fall back to narrating the worktree table's
  "files touched" and the collision matrix, which update on uncommitted dirty
  state, not just commits.
