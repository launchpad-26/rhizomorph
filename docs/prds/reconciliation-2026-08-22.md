# PRD and backlog reconciliation — 2026-08-22

This records what the code, PRD directory and live GitHub backlog say at the same point in
time. The code baseline is `03df141`; the current branch adds documentation only after that
commit. The board was read live on 2026-08-22 with `scripts/dev/issues.sh list`.

The follow-up [code-backed review of the eleven retained PRDs](retained-prds-review-2026-08-22.md)
supersedes this document's preliminary retained-PRD dispositions where they differ. In particular,
prd-30 still has an adoption sweep, prd-33 already has recorded frame measurements, and prd-34
already has the shell, tray, first-run flow and three-platform installer workflow.

## Result

- The live backlog has **24 open issues**, all in the current blessed programme: prd39 (2),
  prd40 (3), prd41 (5), prd42 (5), and prd43 (9).
- Nine PRDs that were still in the root are complete and now live in `done/`: prd19, prd21,
  prd22, prd23, prd26, prd31, prd32, prd35, and prd36.
- Two proposals with no implementation, milestone or backlog are preserved under `parked/`:
  prd37 and prd38. Parking is not a rejection; either requires renewed blessing before it can
  claim backlog space.
- Eleven older PRDs remain in flight or awaiting acceptance: prd14, prd15, prd17, prd20,
  prd24, prd25, prd27, prd29, prd30, prd33, and prd34.
- No GitHub issue was created, edited or closed by this reconciliation. The issue-grooming
  contract requires operator approval of the issue table before tracker writes.

## Why the completed PRDs are complete

| PRD | Evidence in the current tree |
|---|---|
| 19 | `/connect`, connection selectors, doctor facts and exact remedies ship; `2077b6a` removes the `sourceStatus(undefined) → live` lie. |
| 21 | Incremental replay spend, coalesced seek, bounded notches/ticks, axis/readout and loupe all ship. |
| 22 | The original resilience issues ship, including `collector-wrap-boundary.test.ts`: a source-derived structural law with an injected sixth-collector mutation proof. |
| 23 | Capability delivery, route classification, mutation guards, browser/server contract tests and loopback read protection ship. |
| 26 | The capture-gated conformance seam ships and Pi is a real second observation dialect: five provided signals, one honestly partial signal, harness attribution, and verified transcript flow on `/connect`. Pi launching was a stated non-goal and remains prd20 territory. |
| 31 | Kind grammar, bracket structure, trace density and the one typed search across conversation/feed/trace ship; `48ec442` and `panels/search/surfaces.test.tsx` hold the final criterion. |
| 32 | Local typefaces, token laws, measured contrast, one focus token and persisted theme ship. |
| 35 | One settings authority, visible scope/overrides, persistence and weakening-control laws ship. |
| 36 | The organism/list fleet surface and state-preserving switch ship; the run view owns lane study. |

## What remains, and whether today's backlog owns it

| PRD | Current truth | Backlog relationship | Required next act |
|---|---|---|---|
| 14 | Comparison artefacts serialize but are not saved into or reopened from the recording library. | Not covered. prd43 #18 concerns roadmap truth, not artefact persistence. | Rule the storage/reopen seam, then re-groom one bounded wave. |
| 15 | The universal transcript organ and enrichment ladder ship. Multi-orchestrator honesty and the optional PTY tier remain; narrower work moved to successor PRDs. | No direct issue. prd25/27/34 own named successor slices; prd26 is complete. | Amend the umbrella to retain only genuinely shared residual scope. |
| 17 | Four record laws ship; new event families, beacon ingestion, timeline dividends and the fold-order decision do not. | Not covered by prd39–43. | Resolve fold order and beacon ownership before producing a new wave table. |
| 20 | Clone, discovery, launch/relaunch, migration, wizard and guarded retarget engine ship; the wizard cannot invoke retarget for the selected repo. | prd42 hardens path identity at the route boundary but does not add the operator control. | Bless the remaining operator flow, then groom its browser fence. |
| 24 | Many contract/law improvements ship, but the original audit plan has been overtaken by later PRDs and ADR-0026. | Partly superseded by prd39, prd41 and prd43. | Re-audit after those PRDs land; do not duplicate their issues now. |
| 25 | There is still no `windows-latest` leg in the main CI or pack-smoke matrix. | Not covered. The desktop workflow having a Windows build is not the native CLI/support gate this PRD asks for. | Bless the proposed rulings, especially CI spend and expected-failure policy, before grooming. |
| 27 | The shared condition vocabulary and false-summons protection ship; beacon declaration/lapse and build-capability staleness voice do not. | Not covered. prd41's lab timeouts are a different boundary. | Decide beacon door, lapse interval and configured-but-silent meaning; then groom. |
| 29 | Seven SPA reads use `gated-read`; the final policy for other reads/consumers is unresolved. | prd43 #23 is explicitly blocked on this ruling. | Make the policy ruling first; then unblock or reshape #23. |
| 30 | The shared card, condition selector and teach layer ship; `MarkHoverCard`, the loupe read-out and semantic `title=` adoption remain. | Not covered. | Re-cut the adoption sweep by directory, widen the full-scope law, then perform first-glance acceptance. |
| 33 | The scene implementation and recorded before/after frame measurements ship. Its old five-lane criterion is superseded by ruling 10's seven-lane cap. | No implementation issue is justified yet. | Run the booked first-glance operator act; file only observed failures, or move the PRD to `done`. |
| 34 | Shell, tray, first run, installer packaging and updater gating ship. Signing/feed activation and a measured real-Windows first run remain. | prd43 #21 fixes install identity and CLI listing only; it does not supply release acceptance. | Reframe as release readiness; run the installer workflow and stranger test, then decide signing/feed activation. |

## Overlap rulings

These similarities are not duplicates:

- prd41's bounded laboratory processes and lock ownership do not reopen prd22; prd22's
  collector resilience scope is complete.
- prd42 makes the existing retarget path/identity boundary safe. It does not give prd20's
  wizard a retarget control.
- prd43 #21 repairs what the project claims can be installed. It does not supply prd34's
  installers, signing or update mechanism.
- prd43 #23 cannot silently decide prd29's unresolved read-capability policy; its blocker is
  real and should remain explicit.
- prd24's broad audit ambitions must be re-cut after prd39–43 rather than copied into a second
  issue set.

## Tracker gate

There is deliberately no new issue table to approve yet. Every surviving older slice is either
waiting for a product/architecture ruling, an operator acceptance act, or completion of the
already-live prd39–43 programme. Creating issues now would turn stale sequencing into current
authority and duplicate work already on the board.

The next tracker-writing pass should start only after the operator chooses which of these three
things happens first:

1. rule prd29 so prd43 #23 can proceed;
2. bless the small prd20 wizard-retarget remainder; or
3. bless prd25's Windows policy and CI spend.

That pass must return a wave table with present-tense issue titles, explicit file fences,
blockers, type, timeline and priority for approval before any GitHub mutation.
