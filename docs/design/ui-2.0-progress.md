# UI 2.0 authorship — progress

> A resume file. If a session died mid-run, read
> `docs/design/ui-2.0-decisions.md` first, then this, and continue from the
> first unchecked line. Nothing below is held anywhere but in the repo.

**Branch:** `uiera-authoring` (cut from `origin/ui-era-prds`, PR #473).
**Rule:** commit after every document, push after every PRD.

## Artifacts

- [x] `docs/design/ui-2.0-decisions.md` — the decision record (D1–D52)
- [x] `docs/design/ui-2.0-progress.md` — this file
- [x] `docs/prds/README.md` — amend the length rule, rewrite the PRD-as-spec
      anti-pattern (D49)
- [x] `docs/prds/prd-32-the-readable-instrument.md` — expand to spec depth
- [x] `docs/prds/prd-35-the-operators-hand.md` — NEW (settings)
- [ ] `docs/prds/prd-30-the-open-hand.md` — expand
- [ ] `docs/prds/prd-31-the-bracketed-voice.md` — expand; **rewrite ruling 1**
- [ ] `docs/prds/prd-36-the-fleet-surface.md` — NEW (organism ⇄ list)
- [ ] `docs/prds/prd-34-the-doorstep.md` — expand
- [ ] `docs/prds/prd-33-the-living-scene.md` — expand
- [ ] `docs/prds/prd-37-the-shared-world.md` — NEW (team layer)
- [ ] charter amendments (branch `design-charter`, PR #451): category tint,
      light band, raised caps, neutral form-authorship wording
- [ ] cross-PRD consistency pass
- [ ] close #474–#493 as superseded; re-file against the new specs
- [ ] milestones for prd-35 / prd-36 / prd-37
- [ ] journal entry

## Per-PRD spec bar (D49)

Every surface in every PRD answers:

1. what it shows, and why it exists
2. every state — live · empty · loading · error · degraded · replay · demo
3. data source per field, and the honest gap when there is none
4. interactions, and the keyboard path
5. what would make it wrong
6. acceptance criteria

## Notes for whoever resumes

- Ruling numbers are load-bearing (688 code citations). **Never renumber.** New
  decisions become *new* rulings that name what they amend.
- Nobody may enter `packages/web/src/lab/` in an issue fence without
  coordinating with prd-28 (#433–#441, currently unassigned).
- The four immovable numbers: `RECEDE 0.30`, `CALM_CEILING 0.78`,
  `ALARM_FLOOR 0.84`, `CALM_FLOOR 0.15`.
