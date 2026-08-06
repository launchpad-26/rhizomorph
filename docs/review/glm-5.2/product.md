I have enough to write the report.

# Product / docs / vision review

**Verdict**
- The vision is coherent and the user is real — a solo operator running a 6–20-lane worktree agent swarm genuinely lacks a "balcony" view, and `docs/vision.md:9-22` names that gap honestly ("read-only, zero config, no auth, no cloud" is a sharp, defensible posture). The strongest claim is *event-sourced from minute one so replay falls out free*; the weakest is the aesthetic-mysticism prose that dresses a dashboard as a "living thing."
- The 18-PRD structure is mostly **signal** — each PRD landed as code I can see — but the ceremony tax is real: `docs/roadmap.md` spends more words *re-cutting and superseding* earlier PRDs than describing forward work, and several "rulings" read like a one-person legislature drafting minutes for itself.
- README at 47KB is a **symptom**. The Trust section alone (`README.md:95-263`) is a tour-de-force of honesty but ~40% of the file is dashboard aesthetic description ("the cord-cut," "amber ages," "germinating seeds") that belongs in `docs/architecture.md` or a screenshots gallery, not the install surface.

## 1. Vision coherence & real user

Coherent, yes — `docs/vision.md:17-20` draws the balcony/conductor/etude triangle cleanly and refuses scope ("Not a conductor… launches nothing, merges nothing, decides nothing"). Real user: someone running many parallel agent worktrees who currently squints at tmux panes. **Strongest:** event-sourcing-first means replay, the causal record (`packages/core/src/record/`), and the eras corpus (`packages/core/src/eras/era-1/`) all fall out of one decision — compounding leverage. **Weakest:** the value props that aren't "watch the swarm" — judge, lab, eras, pricing — are angled at a *different* user (an experimenter/researcher) than the balcony-watcher, and the vision doc doesn't reconcile them.

## 2. 18-PRD structure: signal or ceremony?

Signal, landed. Spot-checks against code:
- **prd9 "trace era"** — claimed `trace.span` keystone + waterfall + vendored pricing. Landed: `packages/core/src/events/trace.ts`, `packages/web/src/trace/TraceGantt.tsx`, `packages/core/src/pricing/default-model-prices.json` + `PROVENANCE.md`. ✓
- **prd12 "laboratory"** — claimed engine-only fork/checkpoint, no UI. Landed precisely as stated: `packages/server/src/lab/checkpoint.ts`, `packages/server/src/cli/lab-fork.ts`, `packages/core/src/events/lab.ts`, and prd14:3 confirms "There is no `packages/web/src/lab/`." ✓ Honest about its own incompleteness.
- **prd16 "session recorder"** — claimed rotation, lock, transcript capture into artefact dir. Landed: `packages/server/src/log/session-log.ts`, `recorder/rotate.test.ts`, `log/transcript-capture.ts`. ✓
- **prd17 "complete record"** — claimed golden-era corpus folded byte-identically in CI, `upcast()` chokepoint, fsync. Landed: `packages/core/src/eras/era-1/recording.jsonl`, `packages/core/src/events/upcast.ts`, `eras.test.ts`. ✓

**Ceremony tax:** `docs/roadmap.md:10-50` is ~60% "superseded by what actually shipped" retractions. prd3–prd6 each *didn't build their original claim* (catch-up brief, task graphs, LiteLLM, dispatch optimizer) and the roadmap admits it — that's honesty, but it's also evidence the PRD slot was over-allocated before the work was understood. Four PRDs whose primary legacy is "we decided not to do that this week" is process overhead a solo project doesn't amortize.

## 3. README: 47KB strength or symptom

Symptom. What belongs in README: install/run (`:23-69`), Trust three-hands summary (`:95-263`), support matrix (`:264-274`), "what it does not do" (`:275-291`), maintenance/license. What must move out: the entire **Dashboard** section (`:432-777`, ~345 lines / ~20KB) — palette, ribbons, parked lanes, camera, cord-cut, germinating seeds, amber aging — is aesthetic spec prose that no installer needs and every contributor can find in `docs/architecture.md` (already 149KB) or regenerate from `docs/screenshots/`. The Trust section's line-by-line file citations (`:137-210`) are exemplary for a security-sensitive tool but would also survive a 3x compression to a table.

## 4. Scope creep: judge / eras / lab / telemetry / pricing

- **Telemetry + pricing**: justified, foundational, and the moat — cost-without-phone-home is the actual differentiator vs Langfuse. Keep.
- **Eras (golden corpus, upcast)**: justified *as durability infrastructure* for replay, speculative as a user-facing concept. The word "era" appears nowhere a user would look; it's internal hygiene wearing product vocabulary.
- **Lab (fork/compare)**: speculative for the balcony-watcher but genuinely novel as "git bisect for agent runs." Risk: prd14 admits the engine shipped with *nothing reaching it* (`prd14.md:7` "an engine nothing can reach") — classic over-build-before-UI. Justify only if a second real user (the experimenter) is named; otherwise cut the UI and keep the engine dormant.
- **Judge**: `packages/server/src/judge/` exists (merge-tree, symbols, lanes) — speculative; it's "the instrument's own judgements" (prd17) but reads like scope invented to fill a PRD. Cut until someone asks "did this lane actually land cleanly?" out loud.

## 5. Roadmap realism: one highest-leverage next thing, what to cut

**Highest-leverage next:** the **catch-up brief** (`docs/roadmap.md:60`, deliberately left as cohort flagship) — "what did my swarm do while I was away" as a first-class digest. It's the only roadmap item that serves the *named* balcony user rather than the experimenter, and the trace + session-record substrate is already in place to build it cheaply. It is also the only item that would make a stranger retain the tool past first run.

**Cut:** (1) the lab UI (prd14) until a second user exists — engine stays dormant; (2) judge as a product surface; (3) the dispatch-policy bandit (`docs/roadmap.md:36`, `:65`) — explicitly "never lives in the Rhizomorph" already, so stop carrying it on the roadmap; (4) README dashboard prose → architecture doc. **Keep the discipline, drop the legislature:** replace 18 forward PRDs with a one-page "what ships next" and let `docs/architecture.md`'s decision log be the only retrospective surface.
