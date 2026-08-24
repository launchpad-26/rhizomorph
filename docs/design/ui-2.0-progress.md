# UI 2.0 authorship — progress

> **A dated record, not a resume file.** What follows recorded the UI 2.0
> authorship run as it stood when it was written, ~2026-08-16, on the repository
> that was deleted 2026-08-19 and re-uploaded 2026-08-21 — so every
> issue, milestone, branch and PR number below is dead provenance: it cites what
> was filed, not anything a reader can board, dispatch or open. Review and
> dispatch have since happened and much of the stack is built — prd-31, prd-32,
> prd-35 and prd-36 sit in `docs/prds/done/`, prd-37 is parked, and the live
> backlog is milestones prd40–prd45. Read `docs/design/ui-2.0-decisions.md` for
> the intent behind the era; read this for what the run produced, and for
> nothing else. Restamped 2026-08-25 against `main` at `4140f6b`.

**Branch, at the run:** `uiera-authoring` (cut from `origin/ui-era-prds`, PR
#473) — branch, base and PR all died with the old repo.
**Status, at the run: the authorship run was COMPLETE**, awaiting human review
and, after that, dispatch. Both have since happened.

## Artifacts — all landed

- [x] `docs/design/ui-2.0-decisions.md` — the decision record (D1–D52)
- [x] `docs/design/ui-2.0-progress.md` — this file
- [x] `docs/prds/README.md` — the specifying-PRD amendment (D49)
- [x] `docs/prds/done/prd-32-the-readable-instrument.md` — +5 rulings, +5 spec sections
- [x] `docs/prds/done/prd-35-the-operators-hand.md` — NEW (settings, and the
      never-configurable list)
- [x] `docs/prds/prd-30-the-open-hand.md` — +1 ruling, +2 spec sections
- [x] `docs/prds/done/prd-31-the-bracketed-voice.md` — ruling 1 rewritten, +4 rulings,
      +4 spec sections
- [x] `docs/prds/done/prd-36-the-fleet-surface.md` — NEW (organism ⇄ list)
- [x] `docs/prds/prd-34-the-doorstep.md` — +5 rulings, +3 spec sections
- [x] `docs/prds/prd-33-the-living-scene.md` — +7 rulings, +1 spec section
- [x] `docs/prds/parked/prd-37-the-shared-world.md` — NEW (the team layer; parked
      2026-08-22 pending renewed product blessing)
- [x] charter amendments on `design-charter` (PR #451): four pending rulings
      answered, forms clause neutralised
- [x] cross-PRD consistency pass (lab fence on all eight, no stale attributions,
      the four immovable numbers cited consistently, `Kind: specifying` on all)
- [x] #474–#493 closed as superseded, with the reason on each
- [x] 28 issues re-filed: **#548–#575**
- [x] milestones created: prd-35 (21), prd-36 (22), prd-37 (23)

The last three lines record the old repo's boarding, and they record it nowhere
else. None of that numbering survived the re-upload: the live tracker carries
milestones prd40–prd45 under its own issue numbers, so #548–#575, milestones
21–23 and the superseded #474–#493 are provenance rather than work.

## The issue set, by stage — as filed on the old repo, 2026-08-16

| stage | issues |
|---|---|
| 1 · foundation + settings | #548 foundation · #549 nav + window floor · #550 settings + the law · #551 light · #552 dock |
| 2 · reading surfaces | #553 kind module (**before prd-28 w3**) · #554 disclosure card · #555 fleet surface · #556 run view + lane index · #557 phase/refusals/subagents · #558 history surface · #559 search · #560 condition selector · #561 teach + `title=` sweep · #562 list pass, canvas floor, the peek |
| 3 · the doorstep | #563 shell · #564 daemon · #565 first run, demo, installers |
| 4 · organism ‖ shared world | #566 renderer spike (**gates 33 w2–3**) · #567 measure concurrency · #568 growth · #569 material + ambient · #570 colonies + still · #571 identity · #572 the veil · #573 collisions + org · #574 settings groups |
| 5 · era-last | #575 the sweeps |

Plus **#158** (the glance re-run, an operator act) already milestoned to prd-33.
That milestone died with the repo; the obligation did not — it lives in prd-33's
own wave-0 gate text, as the charter's §8 standing booking records.

## What a reviewer should read, in order

1. `docs/design/ui-2.0-decisions.md` — the reframe and the 52 decisions.
2. prd-32 (everything consumes it), then prd-35.
3. prd-30, prd-31, prd-36.
4. prd-34, then prd-33 and prd-37.

## What was owed at the end of the run — overtaken, kept as the record

Not a dispatch plan, and no longer an action list: the tracker these three items
pointed at no longer exists, and the first two were overtaken by the re-upload
rather than done as written.

- **Boarding the new issues** — timeline/priority/type/status via
  `scripts/dev/issues.sh`. GitHub's GraphQL budget was exhausted twice during
  the night, so this was left undone rather than half-done; #548–#575 were gone
  before anyone came back to it.
- **Team review** of the stack, then dispatch of #548 as the era's first wave.
  Both happened on the re-uploaded repo instead, against its own numbering —
  prd-31, prd-32, prd-35 and prd-36 are built and sit in `docs/prds/done/`.
- The **glance re-run** before the era closes (gate amended, not skipped). This
  is the one obligation here that outlived its number: it is an operator act with
  a real lay viewer, and it is carried by prd-33's wave-0 gate now that #158 is
  dead.

## Notes for whoever resumes

- Ruling numbers are load-bearing (688 code citations). **Never renumber.**
- prd-31 ruling 1 was **rewritten**, not amended — it was unbuilt and unmerged,
  so the law test gets written correctly the first time.
- The four immovable numbers: `RECEDE 0.30`, `CALM_CEILING 0.78`,
  `ALARM_FLOOR 0.84`, `CALM_FLOOR 0.15`.
- Nobody enters `packages/web/src/lab/**` without coordinating with whoever owns
  the lab's design. At the run that was prd-28 (#433–#441, unassigned at the
  time); prd-28's paper did not survive the re-upload, so the lab's design
  authority is now its 2026-08-24 re-founding on a design canvas.
