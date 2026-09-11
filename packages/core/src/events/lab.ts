import { z } from 'zod'
import { isHeldBack, RD_MULTI_DIMENSION_REFUSAL, RD_PATTERN_FLOOR, rdDimensionsOf, rdDimensionsVariedCount } from '../lab/rd.js'
import { nonEmptyString, timestampSchema } from './common.js'

/**
 * prd12 ruling 1 — the read-only amendment's two hands. The observer
 * (collectors: git, tmux, workmux, system, sessionlog, otel) stays read-only
 * absolutely and forever, and its source vocabulary lives in
 * `eventSourceSchema` (common.ts) undisturbed. The laboratory is the second,
 * explicitly-invoked hand — a fork engine, never a collector — and this
 * module is its one event type.
 *
 * `source: 'lab'` is deliberately NOT added to `eventSourceSchema`: that enum
 * documents "which collector saw it", and the lab never runs unattended
 * behind a poll loop the way a collector does. Keeping it out is itself part
 * of the amendment's honesty — a reader of `common.ts` should not be able to
 * mistake the lab for a seventh collector.
 *
 * Two event types live here now: `fork.checkpoint` (phase 1, #148 — the
 * capture) and `fork.dispatched` (phase 2, #153 — the launch).
 */

/** Who triggered the capture. `dispatch`/`gate` are conduct-tooling hooks that land later; `operator` is the explicit CLI invocation this keystone ships. */
export const forkCheckpointCapturedBySchema = z.enum(['dispatch', 'gate', 'operator'])
export type ForkCheckpointCapturedBy = z.infer<typeof forkCheckpointCapturedBySchema>

/**
 * Additive keystone event (prd12 ruling 2): binds, at capture time, the
 * rhizomorph event log's own index to a Claude Code session-file byte offset
 * and a git workspace snapshot — the three coordinates a fork needs to scrub
 * to T and resume. Never synthesized after the fact (the spike's keystone
 * finding): a checkpoint event only ever describes a capture that just ran.
 */
export const forkCheckpointPayloadSchema = z.object({
  lane: nonEmptyString,
  checkpointId: nonEmptyString,
  /** The rhizomorph event log's own length at capture — the index this event lands at. */
  eventIndex: z.number().int().nonnegative(),
  /** Absolute path to the lane's Claude Code session JSONL, native on disk — referenced, never copied (spike Q3). */
  sessionFile: nonEmptyString,
  /** Byte offset into `sessionFile` at capture time — a fork cuts the file here. */
  sessionCutByte: z.number().int().nonnegative(),
  /** sha256 hex digest of `sessionFile`'s first `sessionCutByte` bytes. */
  sessionDigest: z.string().regex(/^[0-9a-f]{64}$/, 'sessionDigest must be a sha256 hex digest'),
  /** The namespaced ref the snapshot commit lives under — ruling 1's write fence, enforced at the schema too. */
  snapshotRef: z
    .string()
    .regex(/^refs\/rhizomorph\/checkpoints\/.+$/, 'snapshotRef must be under refs/rhizomorph/checkpoints/'),
  /** The synthetic commit-tree object the temp-index recipe produced (working tree untouched to make it). */
  snapshotSha: nonEmptyString,
  /** HEAD at capture time — the snapshot commit's parent. */
  headSha: nonEmptyString,
  capturedBy: forkCheckpointCapturedBySchema,
})
export type ForkCheckpointPayload = z.infer<typeof forkCheckpointPayloadSchema>

/**
 * Hand-built rather than via `envelope()`: that helper's `source` generic is
 * bound to `EventSource` (`common.ts`), and `'lab'` is deliberately not a
 * member of it (see the module doc above). The shape below is identical to
 * what `envelope('lab', 'fork.checkpoint', forkCheckpointPayloadSchema)`
 * would have produced.
 */
export const forkCheckpointEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('fork.checkpoint'),
  payload: forkCheckpointPayloadSchema,
})

/** A sha256 hex digest — the same shape `sessionDigest` above requires. */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest')

/**
 * What was VARIED for one arm — prd12 ruling 4's "treatment". Both fields are
 * nullable because an arm may vary neither (the control arm: same model, same
 * prompt as the parent lane would have run).
 *
 * The prompt is carried as a digest, never as text: a prompt file can be
 * long, can be edited after the fact, and belongs to the operator — the log
 * needs to say "these two arms ran the same prompt" and "this arm's prompt
 * differed", which a digest answers exactly, without copying the operator's
 * words into an artifact they may later hand to someone else.
 */
export const forkTreatmentSchema = z.object({
  /** Model handle the arm's agent runs, as passed to the agent CLI. Null when the arm inherits the fleet default. */
  model: nonEmptyString.nullable(),
  /** sha256 of the prompt file's bytes. Null when the arm was dispatched without one. */
  promptDigest: sha256Hex.nullable(),
})
export type ForkTreatment = z.infer<typeof forkTreatmentSchema>

/**
 * Additive phase-2 event (prd12 ruling 3): one per RUN of an arm — an arm
 * holds r runs since prd53 ruling 1 — emitted at the moment the lab hands
 * that run to the existing workmux machinery. Its existence is
 * what marks a lane synthetic — there is no separate "please mark me" flag to
 * forget, and no way for a lane to be a fork without the log saying so. The
 * reducer reads exactly this to set `synthetic: true`.
 *
 * `worktreePath` is here beyond the fields prd12 names because a comparison
 * surface must be able to go BACK to the arm it is reporting on — run its
 * gate command, count its commits — and re-deriving that path from a naming
 * convention would silently break the day the convention moves. The log says
 * where the arm lives, so nothing downstream has to guess.
 */
export const forkDispatchedPayloadSchema = z
  .object({
    /**
     * Groups the arms of one fork — one experiment. Every run of every arm
     * shares it, however many CLI calls dispatched them (prd53 ruling 1).
     */
    forkId: nonEmptyString,
    /** The lane that was forked — the real one, whose checkpoint this arm resumes from. */
    parentLane: nonEmptyString,
    /** The `fork.checkpoint` this arm was restored from. */
    checkpointId: nonEmptyString,
    /** 1-based arm number within the fork. */
    arm: z.number().int().positive(),
    /**
     * 1-based run number within the arm (prd53 ruling 1). Absent on every
     * record written before an arm could hold more than one run — read as
     * `run ?? 1`, the same additive convention `beacon.ts` and `git.ts` use.
     * Not an `upcast()`: nothing is reshaped, one field is added.
     */
    run: z.number().int().positive().optional(),
    /**
     * The launch ceiling the operator declared for this dispatch, when they
     * raised it past the default (prd53 ruling 6). Absent means the default
     * held. A declared act, recorded where it happened — never a silent
     * config. Optional and additive, like `run`.
     */
    ceilingOverride: z.number().int().positive().optional(),
    /**
     * The `rd.proposal` this experiment came from (prd55 ruling 4), when it
     * came from one. Absent on every experiment an operator launched by hand,
     * which is most of them and will stay most of them — so absence means
     * "nobody proposed this", never "the proposal was lost".
     *
     * Optional and additive for the same reason `run` and `ceilingOverride`
     * are, and stated in the same words: nothing is reshaped, one field is
     * added, so this is NOT an `upcast()`. A record written before wave 5
     * reads back exactly as it always did.
     *
     * It points the other way from {@link rdOverridePayloadSchema}, and the
     * pair is what ruling 4 needs: the override names the proposal and both
     * checkpoints so the operator's choice can never be re-attributed to the
     * agent, and this names the proposal so the experiment can be read back to
     * what suggested it. Neither says the agent decided anything.
     */
    proposalId: nonEmptyString.optional(),
    treatment: forkTreatmentSchema,
    /** The synthetic lane handle this arm runs under — what the observer will see it as. */
    laneHandle: nonEmptyString,
    /** Absolute path of the restored worktree the arm runs in. */
    worktreePath: nonEmptyString,
  })
  .refine((p) => p.laneHandle !== p.parentLane, {
    message: 'laneHandle must differ from parentLane — an arm may never claim the lane it forked',
    path: ['laneHandle'],
  })
export type ForkDispatchedPayload = z.infer<typeof forkDispatchedPayloadSchema>

/** Hand-built for the same reason `forkCheckpointEventSchema` is — see its doc comment. */
export const forkDispatchedEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('fork.dispatched'),
  payload: forkDispatchedPayloadSchema,
})

/** Who ran the gate: the console's measure route (prd53 ruling 3) or, one day, the CLI's own compare. */
export const forkMeasuredSourceSchema = z.enum(['measure-route', 'compare-cli'])
export type ForkMeasuredSource = z.infer<typeof forkMeasuredSourceSchema>

/** The gate's verdict on one run — `not-run` is legal and means exactly that: no outcome is invented in its place. */
export const forkVerifiedOutcomeSchema = z.enum(['pass', 'fail', 'not-run'])
export type ForkVerifiedOutcome = z.infer<typeof forkVerifiedOutcomeSchema>

/**
 * MEASURING IS A WRITE (prd53 ruling 3). One per RUN measured, emitted by
 * whoever ran the gate in that run's worktree. The outcome is typed with its
 * provenance — which command judged it, who ran that command, when (the
 * event's own `ts`) — so a surface can say "verified by `npm test` on the
 * measure route at 14:02" rather than a bare tick.
 *
 * Only what the gate produced travels here. Cost and duration are the fold's
 * own — it already books `llm.cost` per lane and knows every event's `ts` —
 * so repeating them on this record would let two numbers about one run
 * disagree. Re-measuring appends another record; the fold keeps them all and
 * indexes the latest per lane.
 */
export const forkMeasuredPayloadSchema = z.object({
  forkId: nonEmptyString,
  /** The run's synthetic lane handle — unique per (fork, arm, run) since prd53 ruling 1. */
  laneHandle: nonEmptyString,
  arm: z.number().int().positive(),
  run: z.number().int().positive(),
  verified: forkVerifiedOutcomeSchema,
  /** The failing command's first line, or why it was not run. Null on a pass. */
  verifiedDetail: z.string().nullable(),
  /** The gate command, verbatim — the outcome means nothing without it. */
  verifyCommand: nonEmptyString,
  /** Commits the run made on top of its restored snapshot; null when its worktree could not be read. */
  commits: z.number().int().nonnegative().nullable(),
  source: forkMeasuredSourceSchema,
})
export type ForkMeasuredPayload = z.infer<typeof forkMeasuredPayloadSchema>

/** Hand-built for the same reason `forkCheckpointEventSchema` is — see its doc comment. */
export const forkMeasuredEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('fork.measured'),
  payload: forkMeasuredPayloadSchema,
})

// --- prd55 wave 5 — the R&D hand's four events -------------------------------
//
// Ruling 1: the R&D hand is the operator's own `claude -p` CLI call, spawned
// explicitly by `server/src/lab/rd.ts` (wave 5's second issue, out of this
// fence). Ruling 3: it reads the corpus, groups it into `rd.patterns`, and
// proposes exactly one clean `rd.proposal` per pattern it does not hold back
// — a proposal the pure laws in `lab/rd.ts` would refuse is recorded as
// `rd.refused` instead, never a patched proposal. Ruling 4: `rd.override`
// records the operator changing the checkpoint pick before launch, so the
// choice can never be re-attributed to the agent.

/**
 * Every rd.* event's audit trail (ruling 1): what the CLI's own JSON result
 * reported, never re-derived. `total_cost_usd`/`duration_ms` keep the CLI's
 * own snake_case field names on purpose — this is a direct copy of what
 * `claude -p --output-format json` returned, not a rhizomorph-shaped figure,
 * and the spelling says so at a glance.
 */
export const rdProvenanceSchema = z.object({
  model: nonEmptyString,
  total_cost_usd: z.number().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  /** sha256 of the prompt handed to the CLI — never the prompt text itself (same rationale as `forkTreatmentSchema.promptDigest`). */
  promptDigest: sha256Hex,
  /** sha256 of the corpus the hand read — so two calls over an unchanged corpus are provably the same read. */
  corpusDigest: sha256Hex,
  /** The operator's own `claude --version`, at call time. */
  claudeVersion: nonEmptyString,
  /** Ruling 2: local is the default; `local+tracker` is a second, separately declared act. */
  corpus: z.enum(['local', 'local+tracker']),
})
export type RdProvenance = z.infer<typeof rdProvenanceSchema>

/**
 * One pattern the hand grouped from the corpus (ruling 3). `heldBack` is
 * carried on the wire rather than only derived, so a reader never has to
 * re-run `isHeldBack` to know why a pattern is dim — but the schema refuses a
 * value that disagrees with the law that defines it.
 */
export const rdPatternSchema = z
  .object({
    patternId: nonEmptyString,
    /** The shape sentence — what the items in `sourceItems` have in common. */
    shape: nonEmptyString,
    sourceItems: z.array(nonEmptyString).min(1),
    count: z.number().int().nonnegative(),
    heldBack: z.boolean(),
  })
  .refine((pattern) => pattern.heldBack === isHeldBack(pattern.count), {
    message: `heldBack must equal count < ${RD_PATTERN_FLOOR} (prd55 ruling 3)`,
    path: ['heldBack'],
  })
export type RdPattern = z.infer<typeof rdPatternSchema>

/** The closed vocabulary a proposal's arms may vary in (prd55 ruling 3). */
export const rdVariesDimensionSchema = z.enum(['model', 'brief', 'checkpoint', 'gate'])
export type RdVariesDimension = z.infer<typeof rdVariesDimensionSchema>

/**
 * One arm of a proposal, across the four dimensions {@link rdVariesDimensionSchema}
 * names. `briefDigest` is a digest for the same reason `forkTreatmentSchema.
 * promptDigest` is: the brief is the operator's text, carried as a fingerprint
 * rather than copied into the record.
 */
export const rdArmSchema = z.object({
  model: nonEmptyString.nullable(),
  briefDigest: sha256Hex.nullable(),
  checkpointId: nonEmptyString.nullable(),
  gateCommand: nonEmptyString.nullable(),
})
export type RdArm = z.infer<typeof rdArmSchema>

function armTreatmentOf(arm: RdArm) {
  return { model: arm.model, brief: arm.briefDigest, checkpoint: arm.checkpointId, gate: arm.gateCommand }
}

/** One checkpoint the hand considered and did not choose, with why. */
export const rdCheckpointConsiderationSchema = z.object({
  checkpointId: nonEmptyString,
  reason: nonEmptyString,
})
export type RdCheckpointConsideration = z.infer<typeof rdCheckpointConsiderationSchema>

/** The hand's checkpoint pick (ruling 3): the chosen checkpoint, and every considered-and-rejected one with its reason. */
export const rdCheckpointPickSchema = z.object({
  chosenCheckpointId: nonEmptyString,
  rejected: z.array(rdCheckpointConsiderationSchema),
})
export type RdCheckpointPick = z.infer<typeof rdCheckpointPickSchema>

/** True when a proposal's arms vary at most the one dimension they are allowed to (prd55 ruling 3) — shared by the raw result shape and the recorded event's payload, so neither can drift from the other. */
function hasAtMostOneVaryingDimension(proposal: { arms: readonly RdArm[] }): boolean {
  return rdDimensionsVariedCount(rdDimensionsOf(proposal.arms.map(armTreatmentOf))) <= 1
}

const rdProposalShape = z.object({
  /** A later launch (ruling 4) and a later override name this — minted once, at proposal time. */
  proposalId: nonEmptyString,
  patternId: nonEmptyString,
  varies: rdVariesDimensionSchema,
  arms: z.array(rdArmSchema).min(2).max(3),
  checkpointPick: rdCheckpointPickSchema,
})

/**
 * The raw shape of one proposal, as the fixed R&D result schema carries it
 * (ruling 3) — before anything is recorded as an event. The dimension check
 * is enforced HERE, on the raw shape, so `rdResultSchema` below refuses a
 * two-dimension proposal at the same boundary a hand-rolled result would hit;
 * `rdProposalPayloadSchema` repeats the same check on the recorded event as a
 * second, independent gate (mutation: dropping either `.refine` call lets a
 * two-dimension proposal in through that half alone).
 */
export const rdProposalContentSchema = rdProposalShape.refine(hasAtMostOneVaryingDimension, {
  message: RD_MULTI_DIMENSION_REFUSAL,
  path: ['arms'],
})
export type RdProposalContent = z.infer<typeof rdProposalContentSchema>

/**
 * The fixed shape of one R&D call's raw result (ruling 3): every pattern the
 * hand grouped, and every proposal it drew from them — before the engine
 * (wave 5's second issue) decides, per proposal, whether it is recorded as
 * `rd.proposal` or refused as `rd.refused` via `lab/rd.ts`'s `rdRefusalReason`.
 */
export const rdResultSchema = z.object({
  patterns: z.array(rdPatternSchema),
  proposals: z.array(rdProposalContentSchema),
})
export type RdResult = z.infer<typeof rdResultSchema>

export const rdPatternsPayloadSchema = z.object({
  lane: nonEmptyString,
  patterns: z.array(rdPatternSchema),
  provenance: rdProvenanceSchema,
})
export type RdPatternsPayload = z.infer<typeof rdPatternsPayloadSchema>

/** Hand-built for the same reason `forkCheckpointEventSchema` is — see its doc comment. */
export const rdPatternsEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('rd.patterns'),
  payload: rdPatternsPayloadSchema,
})

export const rdProposalPayloadSchema = rdProposalShape
  .extend({ lane: nonEmptyString, provenance: rdProvenanceSchema })
  .refine(hasAtMostOneVaryingDimension, { message: RD_MULTI_DIMENSION_REFUSAL, path: ['arms'] })
export type RdProposalPayload = z.infer<typeof rdProposalPayloadSchema>

/** Hand-built for the same reason `forkCheckpointEventSchema` is — see its doc comment. */
export const rdProposalEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('rd.proposal'),
  payload: rdProposalPayloadSchema,
})

/**
 * A proposal the pure laws refused (ruling 3, ruling 9): the reason, verbatim,
 * and the raw result's digest — never a patched proposal. `patternId` is what
 * lets the reducer fold this beside the pattern it refused.
 */
export const rdRefusedPayloadSchema = z.object({
  lane: nonEmptyString,
  patternId: nonEmptyString,
  reason: nonEmptyString,
  rawResultDigest: sha256Hex,
  provenance: rdProvenanceSchema,
})
export type RdRefusedPayload = z.infer<typeof rdRefusedPayloadSchema>

/** Hand-built for the same reason `forkCheckpointEventSchema` is — see its doc comment. */
export const rdRefusedEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('rd.refused'),
  payload: rdRefusedPayloadSchema,
})

/**
 * The operator changing the checkpoint pick before launch (ruling 4): names
 * the proposal, the checkpoint the agent picked, and the one the operator
 * chose instead — so the record can never re-attribute the choice.
 */
export const rdOverridePayloadSchema = z.object({
  lane: nonEmptyString,
  proposalId: nonEmptyString,
  agentCheckpointId: nonEmptyString,
  operatorCheckpointId: nonEmptyString,
  provenance: rdProvenanceSchema,
})
export type RdOverridePayload = z.infer<typeof rdOverridePayloadSchema>

/** Hand-built for the same reason `forkCheckpointEventSchema` is — see its doc comment. */
export const rdOverrideEventSchema = z.object({
  id: nonEmptyString,
  ts: timestampSchema,
  source: z.literal('lab'),
  type: z.literal('rd.override'),
  payload: rdOverridePayloadSchema,
})

export const labEventSchemas = [
  forkCheckpointEventSchema,
  forkDispatchedEventSchema,
  forkMeasuredEventSchema,
  rdPatternsEventSchema,
  rdProposalEventSchema,
  rdRefusedEventSchema,
  rdOverrideEventSchema,
] as const
