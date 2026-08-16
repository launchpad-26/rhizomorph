# The concurrency measurement (#567)

Throwaway measurement rig for prd-33 ruling 10's first condition — "the new
caps are derived, not guessed." The finding lives in
[`research/2026-08-16-concurrency-measurement.md`](../2026-08-16-concurrency-measurement.md);
this directory is only how it was obtained.

**Nothing under `packages/` was modified.** The script imports `EVENT` and
`STRUCTURAL` from `packages/web/src/scene/motion.ts` *read-only*, to measure
against the caps as they actually stand rather than a copy that could drift.

## Running it

```
npx tsx research/concurrency/measure.ts
```

Needs the raw session logs the recorder writes, which live **outside this
repo** at `~/.local/share/rhizomorph/<repo-slug>/session-*.jsonl`
(`packages/server/src/log/paths.ts`). This is real fleet telemetry from the
operator's own machine, not a fixture — it is not committed, and a checkout
on a different machine (or a fresh `~/.local/share/rhizomorph`) will find
nothing and every file in `MANIFEST` will be skipped with a `SKIP` line. Set
`RHIZOMORPH_DATA_ROOT` to point at a different data root if the recordings
live somewhere else.

`results.json` is written beside this file on every run and **is** committed
— the derived summary the note cites, small enough to keep, unlike the raw
logs (tens of MB, personal telemetry).

## What each file is

| file | what it is |
| --- | --- |
| `measure.ts` | The whole rig: loads the manifested session logs, derives uncapped pulse/structural intervals the same way `packages/web/src/scene/pulses.ts` would, sweeps them for concurrency, and runs the sensitivity variants. |
| `results.json` | Generated on every run — the numbers the note cites. |

## The manifest

`MANIFEST` in `measure.ts` names ten specific session files across two real
data roots (the current main checkout, and an earlier checkout of the same
project recorded under a different directory name — see the note's "what was
measured" section for how each was confirmed to actually be this repo's own
history). It is a fixed list rather than a directory walk because this
machine's data root also holds ~70 throwaway repos the server's own test
suite created (`plain-repo-*`, `a-repo-with-spaces-*`, `caf----repo-*`) —
walking the directory would silently mix real fleet history with vitest
fixtures.
