## Direction

Docs went stale mid-build once before (#29); this prd ends with them true.

- `docs/demo.md`: rewrite as the ruling-25 demo script — the four
  falsifiable checks (GLANCE 3-second questions; PATHOLOGY point-at-five
  on the staged fixture; SCENE 30-second no-legend explanation; MODE
  "this is the past") with exact keys (1/2/3, Esc, focus), what the
  viewer should see, and what failure looks like.
- `README.md`: refresh the screenshots (all three fixtures + replay), the
  feature list (attention strip, burn strip, fleet table, scene, feed,
  drawer, focus), and the quickstart — fact-checked against `--help` and
  the source (the #29 rule). Stranger-machine: every command runs on a
  clean clone.
- `docs/architecture.md`: prd3 section — the derived fleet object (one
  object, four surfaces), the glyph alphabet's two scales, the pulse-as-
  event laws, the lane manifest flow (#76 wrote its schema section; you
  reconcile, don't duplicate).
- Fact-check the laws' wording against `docs/prd3.md` rulings — quote the
  ruling numbers where the docs assert behaviour.

## Fence (may touch ONLY)

- `docs/demo.md`
- `docs/architecture.md`
- `README.md`
- `docs/screenshots/**`

## Blocked by

#77, #78, #79, #80, #81, #82, #83, #84, #85 (documents what landed).
**Model:** sonnet. **Wave:** 4.

## Definition of done

- Every command in README/demo verified by running it (say which you ran);
  screenshots regenerated from the live app, committed; ruling numbers
  cited; no personal paths anywhere (stranger rule).
- Root `npm test` + `npm run typecheck` green (docs-only, but prove you
  did not break the tree).


---

## Scope additions accrued while waves 2-3 landed (conductor, on the record)

1. **From #75's landing handoff:** append to docs/architecture.md's decision
   log — (a) the ageMs/workAgeMs split (FROZEN reads any-sign-of-life age;
   WAITING inference reads work-age, because pane heartbeats otherwise keep
   the inference permanently alive — both spikes had this bug, the keystone
   fixed it with a test); (b) the ladder floor lives in buildFleet, not the
   view (ALL CLEAR structurally impossible beside non-zero collisions).
2. **From #91:** the /api/lanes `lanes` field is canonically an ARRAY of
   lane entries (the .swarm/lanes.json shape dispatch writes). The web
   consumer was fixed to honour it; note the array shape as canonical in
   the contract section so no future consumer repeats the mismatch.
3. **From #88:** buildFleet folds `llm.cost` events (the token-origin
   filter no longer eats them) — if the docs describe cost provenance,
   they describe it through the fleet object, not a re-derivation.
4. **New since grooming, document if the docs enumerate panels/features:**
   the lane drawer (#84: vitals, activity, transcript tail, ATTACH
   copies-never-executes), panel focus (#85), replay mode shift (#83).

## Practicalities

- A live server is already running against this repo at 127.0.0.1:4400
  (restart it yourself if you need to: `npm start -- <repo-path> --port
  4400`). Playwright + chromium are available via `npx playwright` (cached).
  Regenerate the docs/screenshots/** set from the live app.
- **Committing your work is REQUIRED.** Never push, never merge. Work only
  in this worktree. Stranger-machine rule applies to every command you
  write into the docs: verify each on a path-free, user-free form and say
  which you ran.
