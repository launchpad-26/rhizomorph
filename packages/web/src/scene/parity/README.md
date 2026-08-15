# Parity evidence (#578)

One seeded frame, drawn by both painters, so the renderer swap is *evidenced
rather than asserted*. A painter that draws nothing is the fastest painter there
is.

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
