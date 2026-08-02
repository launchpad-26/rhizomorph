# Vision — the unstructured one

> The dreaming doc, solo this time. Nothing here is a commitment. — Lachlan

## Where the idea came from

Today's brief says the app is not the point — the orchestration is: how many
agents stay useful at once, what breaks first. So the idea had to keep every
station in the kitchen busy, and had to be worth something after demo day.
The audience helped too: JV's own side project (etude) is capture-and-replay
of agent workflows — the socks we're aiming for are made of *process made
visible*. And at home there's already a conductor's podium (the factory's
Mission Control). What doesn't exist is the balcony — the place you watch the
whole orchestra from. That's the gap.

## What we want to exist

Type `rhizomorph` in any repo running a worktree swarm and get a radar
screen at localhost: worktrees as stations, the branch graph growing live,
commits landing as pulses, agents glowing when active and dimming when they
flatline. Instruments aimed at the day's real failure modes — a **collision
matrix** that goes red when two worktrees touch the same file *before* the
merge pain, a **flatline detector** for agents that have quietly died.
Everything event-sourced from the first minute, so **replay** falls out free —
and the demo is the Rhizomorph replaying its own birth. On top: a Three.js
scene that makes the swarm look like the living thing it is.

## What this is never

Not a conductor. It launches nothing, merges nothing, decides nothing —
read-only, zero config, no auth, no cloud, no accounts. Polling is honest
work. It must work on *any* repo full of worktrees, whoever's driving them —
that repo-agnosticism is what makes its organs harvestable for Mission
Control later, and today it stays standalone.

## The quieter vision

The app is the lab instrument for the day's own experiment. If the
constellation is beautiful but the orchestration notes are thin, we half-won.
If it's the reverse, we still won.
