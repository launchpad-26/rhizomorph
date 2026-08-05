# The conductor's bud reads liveness from the fleet snapshot, not the news tail (#154)

`packages/web/src/scene/marks/root.ts` — `conductorBudMarks`, `conductorBud`.

## Context

MAIN's own subagent bud (prd10 ruling 9: "the conductor's subagents bud from
MAIN's own anatomy") used to derive its liveness from `pulses.ts`'s
`conductorSubagentAt`, which only ever looked at the live news tail. That
left a gap: a replayed conductor session's bud did not necessarily grow
where a live one's would have, because the news tail a replay scrubs through
is not the same source a worker's own bud reads.

## Decision

MAIN now reads `fleet.root.subagents` — the same shape, and the same
`selectSubagentActivity` vital, that a lane's own `lane.subagents` is built
from. `RootMass` carries it, resolved off the conductor's own telemetry
handles exactly as a lane's is (`buildFleet.ts`'s `isRootSpend`). One vital,
one `budLife`, read here and in `geometry.ts`'s `layoutBud`: a worker's bud
and the conductor's cannot disagree about when a subagent has finished,
because neither derives its own answer. Because the vital comes off the
fleet snapshot rather than the live news tail, a replayed conductor session
grows its bud exactly where a live one would.
