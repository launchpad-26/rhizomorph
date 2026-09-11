import { RD_HELD_BACK_REFUSAL, RD_MULTI_DIMENSION_REFUSAL } from '@rhizomorph/core'
import type { LabRdProvenance, LabRdRun } from '../types.js'

/**
 * RULING 9's STATE SPECIMENS, drawn before the live one — the same discipline
 * `rail/fixtures.ts` and `canvas/organism.ts`'s fixtures keep, for the same
 * reason: a state that lives only inside a test's inline literal is a state
 * nobody has to keep honest as the shape drifts, and one that lives here is
 * both a fixture AND documentation of what the route actually answers.
 *
 * NO FIXTURE HERE INVENTS A PATTERN (S5's own words): every `shape`,
 * `sourceItems` id and refusal `reason` below is exactly the shape
 * the R&D route (`/api/lab/rd`, `packages/server/src/api/lab.ts`) and the pure laws in
 * `packages/core/src/lab/rd.ts` actually produce — copied, not paraphrased,
 * for the two refusal sentences (`RD_HELD_BACK_REFUSAL`,
 * `RD_MULTI_DIMENSION_REFUSAL`, imported from `@rhizomorph/core` rather than
 * retyped) and for the one sentence the route itself owns
 * (`RD_NO_CLI_SENTENCE`, `packages/server/src/lab/rd.ts` — copied verbatim
 * below because `packages/server/src` is out of this wave's fence and web
 * does not depend on the server package; the live route sends this same text
 * back in `reason`, so the copy is checked against the real route by
 * `packages/contract/src/lab-rd.contract.test.ts`, not merely trusted here).
 */

/** Copied verbatim from `packages/server/src/lab/rd.ts`'s `RD_NO_CLI_SENTENCE` (prd-55 ruling 1). */
export const RD_NO_CLI_SENTENCE_FIXTURE =
  "no claude on this machine's PATH — the R&D hand is your CLI, installed by you"

export const RD_PROVENANCE_FIXTURE: LabRdProvenance = {
  model: 'sonnet',
  total_cost_usd: 0.42,
  duration_ms: 15_320,
  promptDigest: 'a'.repeat(64),
  corpusDigest: 'b'.repeat(64),
  claudeVersion: '2.1.266',
  corpus: 'local',
}

/** *No CLI* (ruling 9): the control is disabled with the PATH sentence, verbatim. Nothing was spawned, nothing recorded. */
export const RD_NO_CLI_RUN: LabRdRun = {
  lane: 'feature',
  available: false,
  reason: RD_NO_CLI_SENTENCE_FIXTURE,
  corpus: { choice: 'local', digest: '', itemCount: 0, trackerRefusal: null },
  patterns: [],
  proposals: [],
  refusals: [],
  provenance: null,
  turns: 0,
}

/** *No corpus* (ruling 9): a repo with no retros and no measured experiment — the hand ran, and read nothing. */
export const RD_NO_CORPUS_RUN: LabRdRun = {
  lane: 'feature',
  available: true,
  reason: null,
  corpus: { choice: 'local', digest: 'c'.repeat(64), itemCount: 0, trackerRefusal: null },
  patterns: [],
  proposals: [],
  refusals: [],
  provenance: RD_PROVENANCE_FIXTURE,
  turns: 1,
}

/** *All held back* (ruling 9): every pattern the hand grouped is a single occurrence — nothing is proposed. */
export const RD_ALL_HELD_BACK_RUN: LabRdRun = {
  lane: 'feature',
  available: true,
  reason: null,
  corpus: { choice: 'local', digest: 'd'.repeat(64), itemCount: 1, trackerRefusal: null },
  patterns: [
    {
      patternId: 'pattern-1',
      shape: 'a checkpoint restore failing on a stale worktree',
      sourceItems: ['fork.measured/w6-413-arm-1@1000'],
      count: 1,
      heldBack: true,
    },
  ],
  proposals: [],
  refusals: [],
  provenance: RD_PROVENANCE_FIXTURE,
  turns: 2,
}

/** *Refused* (ruling 9): the pure laws refused a proposal — the reason is core's own sentence, verbatim, never paraphrased. */
export const RD_REFUSED_RUN: LabRdRun = {
  lane: 'feature',
  available: true,
  reason: null,
  corpus: { choice: 'local', digest: 'e'.repeat(64), itemCount: 2, trackerRefusal: null },
  patterns: [
    {
      patternId: 'pattern-2',
      shape: 'a launch confounding model and brief in the same arm',
      sourceItems: ['fork.dispatched/w6-413-arm-1', 'fork.dispatched/w6-413-arm-2'],
      count: 2,
      heldBack: false,
    },
  ],
  proposals: [],
  refusals: [{ patternId: 'pattern-2', reason: RD_MULTI_DIMENSION_REFUSAL }],
  provenance: RD_PROVENANCE_FIXTURE,
  turns: 3,
}

/** *Live* (ruling 9): a clean pattern with one clean, single-dimension proposal — the ordinary case every other state is drawn beside. */
export const RD_LIVE_RUN: LabRdRun = {
  lane: 'feature',
  available: true,
  reason: null,
  corpus: { choice: 'local', digest: 'f'.repeat(64), itemCount: 4, trackerRefusal: null },
  patterns: [
    {
      patternId: 'pattern-3',
      shape: 'a timeout on the same gate command across three runs',
      sourceItems: [
        'fork.measured/w6-413-arm-1@1000',
        'fork.measured/w6-413-arm-2@1200',
        'docs/research/w6-timeout-retro.md',
      ],
      count: 3,
      heldBack: false,
    },
  ],
  proposals: [
    {
      proposalId: 'proposal-1',
      patternId: 'pattern-3',
      varies: 'model',
      arms: [
        { model: 'sonnet', briefDigest: null, checkpointId: 'ckpt-1', gateCommand: null },
        { model: 'opus', briefDigest: null, checkpointId: 'ckpt-1', gateCommand: null },
      ],
      checkpointPick: {
        chosenCheckpointId: 'ckpt-1',
        rejected: [{ checkpointId: 'ckpt-0', reason: 'predates the gate command that actually timed out' }],
      },
    },
  ],
  refusals: [],
  provenance: RD_PROVENANCE_FIXTURE,
  turns: 4,
}

/** *All held back*, but the ONE row's exact copy — used by the mutation test that proves the render never silently invents a plural. */
export const RD_HELD_BACK_ROW_COPY =
  '1 issue · not yet a pattern — testing a shape that may not recur spends real money'

/** The pattern-list copy when every row is dim (ruling 3, verbatim). */
export const RD_NOTHING_PROPOSED_COPY = 'no pattern recurs — nothing is proposed.'

/** The control's copy when the corpus read nothing (S5, verbatim). */
export const RD_NO_CORPUS_COPY = 'nothing to read yet — a retro, or a measured experiment, is where a pattern comes from.'

/** Re-exported so a test that wants "the sentence core owns" never retypes it either. */
export { RD_HELD_BACK_REFUSAL, RD_MULTI_DIMENSION_REFUSAL }
