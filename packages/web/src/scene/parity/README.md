# Parity evidence (#578, #579)

One seeded frame, drawn by both painters, so the renderer swap is *evidenced
rather than asserted*. A painter that draws nothing is the fastest painter there
is.

Two arms live here now, for the two ways the picture can quietly move:

- **the painter** (#578) — canvas 2D against WebGL2, below.
- **the model** (#579) — the mass's contour before and after it was baked, in
  [the model parity section](#the-model-arm-579).

```
node packages/web/src/scene/parity/capture.mjs            # finds its own baseline
node packages/web/src/scene/parity/capture.mjs --ref abc  # a different before
```

With no `--ref` the harness resolves the **last commit that still had
`paint.ts`** — the parent of the commit that deleted it. A fixed default of
`HEAD` was right for exactly one commit and broke the moment the delete landed,
and a parity harness that cannot resolve its own baseline is one nobody re-runs.
`parity.json` records the sha it actually used.

| file | what it is |
| --- | --- |
| `scene.ts` | the seeded scene — one clock, no randomness, all twelve mark kinds |
| `scene.test.ts` | the capture's own premise, pinned |
| `capture.mjs` | bundles, serves, drives Chromium headful, writes the three PNGs |
| `before.png` | the canvas 2D painter |
| `after.png` | the WebGL2 painter |
| `diff.png` | where they differ, amplified 8× |
| `parity.json` | the adapter, the numbers, and the frame cost |

The three PNGs are written at **CSS size**; every number in `parity.json` is
computed at dpr 2 over the full 2200×1240 buffer. Only the picture is halved —
three device-resolution captures of a noisy scene are 11 MB of binary a repository
has to carry for ever, and the pictures are the check that the numbers describe a
scene rather than the measurement itself.

**The "before" arm is not a copy of `paint.ts`.** It *is* `paint.ts`, fetched with
`git show` into a scratch directory at run time and deleted afterwards, with its
relative imports rewritten to absolute paths
back into the tree — so both arms consume the same shipping `layoutScene` and
`sceneMarks`, and this is a painter comparison rather than two different pictures.
Nothing of the 2D painter survives in the working tree; the comparison reaches back
into history for it, which is the only way to compare against something that has
been removed.

**Chromium runs headful**, for the reason `research/spikes/renderer/run.mjs`
records: headless on this box falls back to SwiftShader, and a software rasteriser
answers every question wrongly while looking like an answer. The run is refused if
the WebGL arm did not reach a real adapter, and `parity.json` records which one it
was.

The reading of the numbers, what the residual delta is made of, and the two defects
this capture found are in [`../gl/README.md`](../gl/README.md).

## The model arm (#579)

`contour.ts` now bakes the mass's field in unit space and *places* it by the
frame's own similarity transform, instead of re-sampling ~20,000 square roots and
re-walking eighteen levels every frame. That is a change to what the model
*produces*, not to how it is drawn, so the painter comparison above cannot see it
— both arms would move together and the diff would stay put. It needs its own
before and after.

| file | what it is |
| --- | --- |
| `contour.ts` | the mass in six states the bake could plausibly break |
| `contour.test.ts` | the comparison, and how the golden was recorded |
| `contour-before.json` | the **pre-bake implementation's own output**, checked in |

```
git stash push -- packages/web/src/scene/contour.ts
WRITE_CONTOUR_BEFORE=1 npx vitest run packages/web/src/scene/parity/contour.test.ts
git stash pop
```

**Vertices, not pixels.** A screenshot of an eighteen-level stack at five per cent
alpha cannot resolve a quarter-pixel move in the silhouette. `contour.test.ts`
compares the silhouette vertex for vertex and every shell by ring count, vertex
count, coordinate sums and radial extremes: the structure exactly, the coordinates
against a bound of a thousandth of a pixel. **Worst move actually observed:
2.4 × 10⁻⁵ px** — twenty-four nanometres of picture, from rounding the unit-space
field to a millionth of a grid cell so that the baked shape is an exact function
of its own cache key.

**And the picture, captured.** `capture.mjs` run twice over the same commit — once
with `contour.ts` stashed, once with it — driving the same headful Chromium on the
same adapter, over the same seeded frame:

| arm | before-model vs after-model |
| --- | --- |
| canvas 2D | **0 pixels of 682,000 differ** — byte-identical PNG |
| WebGL2 | **1 pixel of 682,000**, by 1/255; every other pixel identical |

The canvas arm is the one that carries the signal: it is a deterministic
rasteriser, so byte-identical means the display list it was handed was the same
display list. The WebGL arm's single pixel is a GPU rounding a vertex that moved
by twenty-four nanometres, and `parity.json`'s own `difference` block came back
unchanged to every digit across both runs.
