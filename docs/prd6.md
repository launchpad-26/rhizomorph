# prd6 — the living cycle

prd5 made the instrument an application. Reviewing it, the operator found
the scene's *end state* lifeless and two of its channels unintuitive:
"as output grows the seeds should grow too (within reason, no need to
balloon them out)"; "the severing feels like a bit of a dead end
visually — think about what they could do once they've been severed in a
mycelium theme sense"; "the distance from the node should mean something
more intuitive"; "we should be able to view the main terminal by
clicking on the main node." Rulings from the interview, 2026-08-02:

## Rulings

1. **Seeds grow with the work, absolutely.** Node size maps output on an
   ABSOLUTE scale (log against a fixed reference) with a hard ceiling —
   a 20K lane looks the same whether or not a 500K lane exists beside
   it. The current relative scale (`log1p(output)/log1p(maxOutput)`)
   made every lane shrink when one whale worked harder, which is why
   growth never read. Nothing balloons: the cap is law.
   **A retired seed keeps its size** — this OVERRULES #102's worker
   ruling that "a scar is a mark, so it is the same size for every
   lane." The rim should show what each lane accomplished.
2. **Severed work returns home.** Real mycelium reabsorbs spent hyphae
   and translocates their substance back through the network — which is
   exactly what a merge is. On the cut, the lane's substance flows down
   the severing thread INTO the root-mass, and **the root-mass visibly
   thickens with accumulated session work**. What remains at the rim is
   a dormant seed, not a dead end: the cycle closes.
3. **Dormant seeds germinate.** If a retired lane's handle returns
   (re-dispatch), a new thread grows from its EXISTING seed rather than
   a stranger appearing elsewhere. Slots stay reserved for retired
   lanes; the scene remembers where a lane worked.
4. **Distance is the lifecycle journey.** Born at the centre, growing
   outward as it works, retiring at the rim — distance answers "how far
   through its life is this?" and needs no legend. This REPLACES
   recency-as-distance (prd3 graft g6), which required explaining and
   therefore failed the layman bar; recency keeps the channel it already
   shares — thread lightness. Ruling g7 stands untouched: ANGLE is
   identity and stays stable for the session.
5. **The main node opens the conductor's conversation.** Clicking the
   root-mass opens the same drawer the lanes use, showing the
   conductor's own session CLI-style plus main's vitals (branch,
   landings, total burn). Where the conductor is not instrumented, the
   drawer says so in the gap voice (law 12) rather than showing
   emptiness.

## Implementation waves (issues #106–#108)

Wave 1: **#106** the living cycle (opus — absolute sizing, lifecycle
distance, return-home flow, root-mass growth, germinating seeds) ∥
**#107** the main node's drawer (opus — conductor transcript resolution,
root-mass click, MAIN vitals). Wave 2: **#108** docs/demo/screenshots.
Conductor browser verification per wave; gates run the bounded busy-box
standard (prd3 rulings 33–34).
