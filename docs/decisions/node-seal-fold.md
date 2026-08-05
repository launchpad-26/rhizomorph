# The done seal: bar → knot → fold (prd7 ruling 3, restated by #117)

`packages/web/src/scene/marks/node.ts` — `sealMark`, `sealSpine`, `SEAL`.

## The history — the third form of one law

The seal has been redrawn twice, and the law it carries has grown stricter
each time rather than looser.

It started as a bar struck across the tip: a second vocabulary — flat,
geometric, borrowed from wax seals — laid onto a fact about a growing thing.
prd7 ruling 3 changed it to a *knot*, which was the right idea drawn the wrong
amount: the assertion it left behind was "the spine turns through more than a
full circle," and a full turn is definitionally a ring with an eye in it. So
every landed lane in the fleet wore the same small pretzel, and at thirty-eight
of them on one rim that badge became the loudest repeated motif in the
picture — the exact failure ruling 3 exists to prevent, reintroduced by the
shape its own law forced.

#117 changed it again, to a **fold**: the lane's own substance carried past
the tip, turned back through more than a half-circle, and laid down into the
body it came from, where its width has already gone to nothing. Nothing is
added at the tip — the terminal simply stops reaching and comes home. The
turn's radius follows the lane's own lens, so the eye of the fold is filled by
the cord's own width and there is no ring anywhere in it.

## How the law survives at full strength

The old assertion was one number (`turning > 2π`) plus one sentence in a
comment that was never actually checked ("it comes back to where it
started"). The restatement in `marks.test.ts` asserts four things, and three
of them are new:

1. it **turns back on itself** — total turning ≥ π. A bar has none; this is
   the surviving half of the old claim, at the amount a fold actually needs.
2. it **returns into the node's own body** — the spine's last point is inside
   the lens, while its furthest point is outside it. The old test only *said*
   this; it's asserted now, and it's what separates a seal from the tail
   beside it, which reaches away and ends outside.
3. it is **the cord, not a mark laid on it** — a ribbon, drawn to nothing at
   the end, so it closes rather than stopping.
4. **no two lanes wear the same one.** Given a fleet whose lanes have done
   identical work, every seal must still be a different shape in its own
   node's frame. Nothing in the old law prevented thirty-eight identical
   stamps; this forbids two.

Only clause (1) is laxer than what it replaced, and it is laxer on precisely
the axis that forced the badge in the first place. (2), (3) and (4) are
strictly new, and (4) is the one that would have actually caught the knot's
problem before it shipped.
