# Product / docs / vision review

- **Vision: genuinely coherent, with a real user and a real problem** — rare for a solo demo-day repo. The read-only/event-sourced stance is the strongest idea here; the addressable market is the weakest.
- **The 18 PRDs are mostly signal** — four spot-checked claims landed in code with law-tests attached — but the doc apparatus is starting to lag the code it claims to describe (prd14 says "not landed" while `/lab` is mounted).
- **Highest-leverage next move is distribution, not features:** resolve #177 and publish to npm; freeze the lab and the prd17/prd18 record-richness thread until a stranger files an issue.

## 1. Vision coherence

Yes. `docs/vision.md:13-14` ("What doesn't exist is the balcony — the place you watch the whole orchestra from") is a sharp, differentiated position: not a conductor, read-only, replay-for-free from event sourcing. The user is real and named — the author (`docs/prd0.md:13`, "First real user is this build day itself") plus a cohort inheriting it (`docs/prd9.md:3-4`). The problem — N agents, silent flatlines, file collisions, untracked spend — is real and currently unserved.

**Strongest:** the honesty architecture. Gap-voice instead of guessed numbers, "nothing leaves the machine," law-tests that grep the UI's own source (`packages/web/src/drawer/readonly.test.ts`). That's a trust moat no competitor bothers with. **Weakest:** the market. The full experience requires git worktrees + tmux + workmux + Claude Code + OTel env vars — a sliver of a sliver. prd15 (any OS/CLI/provider) is the correct admission of this, but it's ruled-mostly-not-landed (`docs/roadmap.md:104-118`), and the sessionlog collector still reads `~/.claude/projects`. Today the real user is one person.

## 2. PRD structure: signal or ceremony?

Signal — with a caveat. Spot-checks:

- **prd9 ruling 7** (vendored, SHA-pinned Langfuse pricing): landed — `packages/core/src/pricing/{default-model-prices.json,PROVENANCE.md,LICENSE}` with a parser handling the `(?i)` trap (`prices.ts:11-17`).
- **prd12 ruling 1** (lab confined to `refs/rhizomorph/`, CLI-only): landed — `packages/server/src/lab/namespace-law.test.ts` exists and `cli/index.ts:2-14` is the declared sole importer.
- **prd16 ruling 4** (`/recordings` is a library, never a second overview): landed — `packages/web/src/recordings/no-live-fleet-law.test.ts` greps for `useFleet`.
- **prd13 ruling 13** (density band cut): landed as a cut — `packages/web/src/tide/` contains chapter marks and transport, no lane-band code.

The roadmap's willingness to mark prd3/4/5 "superseded by what actually shipped" is anti-ceremony behavior. The caveat: the apparatus is drifting. `docs/roadmap.md:95-96` says prd14's "wave plan not yet landed," and CHANGELOG has zero prd14 entries — yet `packages/web/src/lab/LabPage.tsx` is live-mounted at `/lab` (`packages/web/src/App.tsx:13`, `router.ts:29`). When the decision record can't keep up with a one-person codebase, 18 PRDs in eight days (2026-07-30 → 08-06) is governance outrunning throughput.

## 3. The 47KB README

Symptom. The Trust section (`README.md:88-200`) is the best thing in the repo and belongs exactly where it is. So do install, doctor, support matrix, and the unpublished-npm honesty note. Everything from "Dashboard" down — the palette table, organic-form spec, cord-cut, germinating seeds, motion budget, keyboard map — is a visual-language reference that belongs in `docs/architecture.md` or the user-guide, which already exists and duplicates the front door (`docs/user-guide/getting-started.md`). The Performance section (`README.md:~340`) is CHANGELOG/architecture material. A trust document works at 200 lines; at 790 it's a second architecture doc wearing a README's name, and prd9's own "junior-proof front door" ruling argues against it.

## 4. Scope creep audit

- **judge**: justified — fence/merge-check is core to the collision value prop, and it's wired (`collectors/judge/collector.ts`, `api/meta.ts`), not decorative.
- **eras**: justified — a golden byte-identical replay corpus in CI (`packages/core/src/eras/CAPTURE.md`) is cheap, correct insurance for an event-sourced tool.
- **telemetry/pricing**: justified — the money layer is the strongest differentiator; pricing is a narrow read-only vendored lookup, correctly scoped.
- **lab**: speculative. A checkpoint/fork/compare experiment engine with its own UI console, built for a user base of one, which amended the founding read-only constitution to exist (`docs/prd12.md:9-20`). Impressive engineering, wrong order. It doubles the trust surface and doc burden before a single external user.

## 5. Roadmap realism

**Do next:** finish prd15's landed-but-incomplete waves, resolve #177, and publish to npm. Every other investment is worthless at zero distribution, and the catch-up brief — self-described as "the strongest user-stated pain" (`docs/roadmap.md:31`) — is the right first post-publish feature. **Cut:** prd18's rich UI over prd17 event families, the "forest"/multiplayer thread, and the dispatch-policy bandit — all correctly parked, and they should stay parked until the second real user shows up.
