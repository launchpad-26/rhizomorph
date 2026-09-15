import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

/**
 * PROCESS-SOURCED EVENTS — prd-57 ruling 1 and ruling 2, licensed by ADR-0052.
 *
 * The operating system's process table is the one witness that exists before
 * any configuration and regardless of how anything was launched. It sees an
 * agent in a multiplexer, in an IDE terminal, in a plain shell, started by a
 * script or by another agent. These three families are what it says.
 *
 * ## What may be in here, and what may never be
 *
 * ADR-0052 admits a process as an **actor** only when its argv matches a known
 * agent signature, and records pid, dialect, start time, placement, CPU and RSS
 * deltas, and parentage among matched actors. It records **nothing else**:
 * never argv beyond the match, never an environment variable, never a process
 * that is not a signature match.
 *
 * That last clause is the one with teeth. A command line can carry a prompt; an
 * environment can carry a key. `process.test.ts` plants a marker in a
 * `claude -p "<marker>"` command line and follows it in — and asserts a
 * `process.seen` WAS emitted in the same run, because a marker test over an
 * empty list passes for the wrong reason.
 *
 * **Which of those defences is this file's, stated exactly** (review of #553,
 * B2 — an earlier draft of this paragraph claimed all of them and was wrong):
 *
 * - A key this schema does not name is **dropped by the parse**. That is this
 *   file's guarantee and it is unconditional: argv cannot arrive under a name a
 *   collector invents for it.
 * - Every string field here is **bounded** — `dialect` at 64, `worktreePath` at
 *   4096 — so nothing unbounded rides through either.
 * - But a bound stops volume, never shape. A path is a string, a roster name is
 *   a string, and a realistic command line is 61 characters — **under both
 *   ceilings**. Nothing in this file distinguishes one from a real path or a
 *   real dialect. What keeps argv out of those two fields is upstream: the
 *   collector puts a canonicalised cwd in one (prd-57 ruling 3) and a member of
 *   the probe's closed `AGENT_COMMANDS` roster in the other. Both are tested
 *   where they are decided, not here.
 *
 * ## The payloads are closed the repo's way, which is not `.strict()`
 *
 * `.strict()` appears nowhere in this repo, and ADR-0011 is why: a refusing
 * parse rots a log that must fold recordings from older eras. The idiom here is
 * the one `tmux.test.ts` already uses — a fixed key set asserted structurally,
 * unknown keys stripped on parse — and `no-open-payload-law.test.ts` sweeps
 * this directory by glob, so it picks this file up with no edit and no registry
 * entry.
 */

/**
 * A roster dialect, as the collector's signature match named it. A string
 * rather than a union: the signature list lives with the collector in
 * `packages/server`, and `packages/core` may not reach into it. The law in
 * `collectors/process/` asserts every signature is a roster id, which is the
 * check that belongs where the two sets are both visible.
 */
const dialectSchema = nonEmptyString.max(64)

/**
 * Where an actor is, and how sure we are.
 *
 * `rooted` — cwd resolved to a git worktree. `unrooted` — the actor is real and
 * belongs to no repository; prd-58 ruling 6 gives that case a home rather than
 * dropping it. `unknown` — this platform cannot read another process's working
 * directory at all, which is Windows: `Get-CimInstance` yields argv and not cwd,
 * and the leg says so rather than guessing.
 */
export const actorPlacementSchema = z.enum(['rooted', 'unrooted', 'unknown'])
export type ActorPlacement = z.infer<typeof actorPlacementSchema>

/**
 * A roster-matched agent process has appeared.
 *
 * `worktreePath` is **canonical when present** and the collector is what makes
 * it so. `canonicalize` lives in `packages/server/src/paths/containment.ts` and
 * imports `node:fs`, which ADR-0003 keeps out of this package — so core can
 * compare this value and can never normalise it. prd-57 ruling 3 puts the
 * obligation at the collector for exactly that reason.
 */
export const processSeenPayloadSchema = z.object({
  pid: z.number().int().positive(),
  dialect: dialectSchema,
  /** Epoch ms. With `pid`, the identity of one run: a recycled pid is a different actor. */
  startedAt: z.number().int().nonnegative(),
  /**
   * Bounded, like `beacon.ts`'s `cwd` beside it and `dialect` above it.
   *
   * Review of #553, B2: this was the one path-shaped field in the wave with no
   * ceiling, and unbounded free text here contradicts this file's own claim
   * that it has no field a command line could occupy. The ceiling does not by
   * itself make the field unable to HOLD one — a path is a string, and a short
   * command line is under any ceiling worth setting — so the claim is carried
   * by the two things together: this bound, and the fact that a key this schema
   * does not name is dropped by the parse. A collector cannot smuggle argv
   * through under a name of its own choosing, and cannot smuggle an unbounded
   * amount of anything through this one.
   */
  worktreePath: nonEmptyString.max(4096).nullable(),
  placement: actorPlacementSchema,
  /**
   * The parent, only when the parent is ITSELF a matched actor — a conductor
   * and its subagents. Never a shell, never an editor, never init: parentage
   * among actors is a fact about the swarm, and parentage in general is a fact
   * about the operator's machine that ADR-0052 does not license recording.
   */
  parentPid: z.number().int().positive().nullable(),
})
export type ProcessSeenPayload = z.infer<typeof processSeenPayloadSchema>

/**
 * What an actor consumed since the last tick, emitted **only when it changed**.
 *
 * Edge-triggered rather than per-tick, for the reason `lane-state.ts` already
 * records about `agent.status`: `buildFleet` folds events into the recency a
 * stall is measured against, so an organ that re-announced every tick would
 * refresh the very silence the flatline detector is watching for.
 */
export const processActivityPayloadSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  cpuMsDelta: z.number().int().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
})
export type ProcessActivityPayload = z.infer<typeof processActivityPayloadSchema>

/**
 * The actor is no longer there.
 *
 * Two conditions, one word: the pid is absent from the table, OR the pid is
 * present carrying a different start time. The second is a recycled pid, and it
 * is `gone` followed by a new `seen` rather than a silent substitution — the
 * probe's own laws already refuse to let a recycled pid impersonate a live
 * agent, and an event stream that blurred them would hand that confusion
 * downstream.
 *
 * **This is the only fact that can produce `crashed`** (prd-57 ruling 5): a
 * `gone` following a `seen` with no session end between. Never silence — a lane
 * that has merely stopped speaking is alive until a witness says otherwise, and
 * that is what `frozen` is for.
 */
export const processGonePayloadSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  /** `recycled` when the pid is present under a different start time; `absent` when it is not there at all. */
  reason: z.enum(['absent', 'recycled']),
})
export type ProcessGonePayload = z.infer<typeof processGonePayloadSchema>

export const processSeenEventSchema = envelope('process', 'process.seen', processSeenPayloadSchema)
export const processActivityEventSchema = envelope('process', 'process.activity', processActivityPayloadSchema)
export const processGoneEventSchema = envelope('process', 'process.gone', processGonePayloadSchema)

export const processEventSchemas = [
  processSeenEventSchema,
  processActivityEventSchema,
  processGoneEventSchema,
] as const
