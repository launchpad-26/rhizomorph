# UI 2.0 authorship — progress

> A resume file. If a session died mid-run, read
> `docs/design/ui-2.0-decisions.md` first, then this. Nothing below is held
> anywhere but in the repo.

**Branch:** `uiera-authoring` (cut from `origin/ui-era-prds`, PR #473).
**Status: the authorship run is COMPLETE.** What remains is human review and,
after that, dispatch.

## Artifacts — all landed

- [x] `docs/design/ui-2.0-decisions.md` — the decision record (D1–D52)
- [x] `docs/design/ui-2.0-progress.md` — this file
- [x] `docs/prds/README.md` — the specifying-PRD amendment (D49)
- [x] `docs/prds/prd-32-the-readable-instrument.md` — +5 rulings, +5 spec sections
- [x] `docs/prds/prd-35-the-operators-hand.md` — NEW (settings, and the
      never-configurable list)
- [x] `docs/prds/prd-30-the-open-hand.md` — +1 ruling, +2 spec sections
- [x] `docs/prds/prd-31-the-bracketed-voice.md` — ruling 1 rewritten, +4 rulings,
      +4 spec sections
- [x] `docs/prds/prd-36-the-fleet-surface.md` — NEW (organism ⇄ list)
- [x] `docs/prds/prd-34-the-doorstep.md` — +5 rulings, +3 spec sections
- [x] `docs/prds/prd-33-the-living-scene.md` — +7 rulings, +1 spec section
- [x] `docs/prds/prd-37-the-shared-world.md` — NEW (the team layer)
- [x] charter amendments on `design-charter` (PR #451): four pending rulings
      answered, forms clause neutralised
- [x] cross-PRD consistency pass (lab fence on all eight, no stale attributions,
      the four immovable numbers cited consistently, `Kind: specifying` on all)
- [x] #474–#493 closed as superseded, with the reason on each
- [x] 28 issues re-filed: **#548–#575**
- [x] milestones created: prd-35 (21), prd-36 (22), prd-37 (23)

## The issue set, by stage

| stage | issues |
|---|---|
| 1 · foundation + settings | #548 foundation · #549 nav + window floor · #550 settings + the law · #551 light · #552 dock |
| 2 · reading surfaces | #553 kind module (**before prd-28 w3**) · #554 disclosure card · #555 fleet surface · #556 run view + lane index · #557 phase/refusals/subagents · #558 history surface · #559 search · #560 condition selector · #561 teach + `title=` sweep · #562 list pass, canvas floor, the peek |
| 3 · the doorstep | #563 shell · #564 daemon · #565 first run, demo, installers |
| 4 · organism ‖ shared world | #566 renderer spike (**gates 33 w2–3**) · #567 measure concurrency · #568 growth · #569 material + ambient · #570 colonies + still · #571 identity · #572 the veil · #573 collisions + org · #574 settings groups |
| 5 · era-last | #575 the sweeps |

Plus **#158** (the glance re-run, an operator act) already milestoned to prd-33.

## What a reviewer should read, in order

1. `docs/design/ui-2.0-decisions.md` — the reframe and the 52 decisions.
2. prd-32 (everything consumes it), then prd-35.
3. prd-30, prd-31, prd-36.
4. prd-34, then prd-33 and prd-37.

## Owed next (not done by this run)

- **Board the new issues** — timeline/priority/type/status via
  `scripts/dev/issues.sh`. GitHub's GraphQL budget was exhausted twice during
  the night, so this was left undone rather than half-done.
- **Team review** of the stack, then dispatch #548 as the era's first wave.
- The **glance re-run (#158)** before the era closes (gate amended, not skipped).

## Notes for whoever resumes

- Ruling numbers are load-bearing (688 code citations). **Never renumber.**
- prd-31 ruling 1 was **rewritten**, not amended — it was unbuilt and unmerged,
  so the law test gets written correctly the first time.
- The four immovable numbers: `RECEDE 0.30`, `CALM_CEILING 0.78`,
  `ALARM_FLOOR 0.84`, `CALM_FLOOR 0.15`.
- Nobody enters `packages/web/src/lab/**` without coordinating with prd-28
  (#433–#441, currently unassigned).
