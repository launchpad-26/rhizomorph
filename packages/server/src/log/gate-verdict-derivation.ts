import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { createEvent, gateVerdictPayloadSchema, type EventOf } from '@rhizomorph/core'
import { beaconDirFor } from '../collectors/beacon/paths.js'
import { canonicalize, isInside } from '../paths/containment.js'

/**
 * `gate.verdict`, derived from a `beacon.received` sidecar (prd17 ruling 6,
 * #280). `beacon.received` is the occurrence — writer, kind, lane, a digest
 * of the beacon line itself, and where it lives (`file` + `offset`).
 * `scripts/gate.sh`'s `emit_gate_verdict` writes a v1 line whose `kind` is
 * the literal string `"gate.verdict"` and whose extra keys — `held`,
 * `reason`, `outputDigest`, `loadBatches` — are ignored by the beacon
 * collector and covered by its digest, never carried onto `beacon.received`
 * itself. This is where they are read back out.
 *
 * **Two digests, not one.** `beacon.received.digest` is a hash of the beacon
 * *line*, and is what this function re-derives and compares before trusting
 * the line's contents at all. `outputDigest` inside the line is a hash of
 * the *gate's own captured output* and becomes `gate.verdict.digest` — the
 * two never get confused here because the beacon's digest is checked, and
 * discarded, before `outputDigest` is ever read.
 *
 * Every refusal path returns a reason rather than throwing or returning
 * silently (ADR-0011's count-and-voice rule, applied to a derivation rather
 * than a parse): a missing, empty, truncated, offset-past-end, unresolvable,
 * or out-of-containment sidecar; a line with no newline inside
 * {@link MAX_GATE_VERDICT_LINE_BYTES} of the offset; a line whose bytes no
 * longer match `beacon.received.digest` (altered since it was recorded); a
 * line that fails `gateVerdictPayloadSchema` (most commonly because the
 * gate's own tee never drained, so `outputDigest` was correctly omitted
 * rather than emitted empty); and an I/O error reading the sidecar itself
 * (a real disk fault, not a crafted input) all refuse with their own reason.
 * **None of them throws — round 4's review found this promise broken by
 * omission, not by a crafted input: the bounded read below is wrapped in its
 * own try/catch for exactly that reason, the same shape the `open` call
 * beside it already had. Round 5's review then found the SIBLING one line
 * further on: the `close()` in that read's `finally`, whose rejection
 * replaces the value the `catch` had already returned and so escaped past
 * both catches. Every one of the three calls that touches the descriptor —
 * `open`, `read`, `close` — now has its own handler, and the `finally`'s is
 * the one that deliberately swallows: see it for why a proven verdict is not
 * discarded over a failed close.**
 *
 * Called at RECORD time (`poll-loop.ts`'s recording seam, prd17 ruling 6's
 * 2026-09-09 operator ruling), not at replay/fold time: deriving here makes
 * the log self-sufficient — a `gate.verdict` this function produced survives
 * a pruned or never-exported `beacons/` directory, because nothing later
 * needs to re-read the sidecar to recover it.
 *
 * **Bounded, not "offset to EOF."** `read-beacon-lines.ts` next door reads
 * `size - offset` in one call, which is correct THERE because it is a TAIL
 * reader — everything new since the last read is exactly what it wants, and
 * its cursor advances so it never re-reads. This derivation wants one line
 * at a possibly EARLY, fixed offset in a file that only grows, so copying
 * that shape (round 3's fix) inherited a cost with no justification here: a
 * valid first line followed by megabytes of later, unrelated appends still
 * read every one of those bytes before ever finding this line's newline.
 * {@link MAX_GATE_VERDICT_LINE_BYTES} bounds the read to a window around the
 * offset instead, so the cost of deriving one verdict never depends on how
 * large the sidecar has grown since.
 */
export type GateVerdictDerivation =
  | { outcome: 'derived'; event: EventOf<'gate.verdict'> }
  | { outcome: 'not-a-gate-verdict-beacon' }
  | { outcome: 'refused'; reason: string }

/**
 * The most this derivation will ever read to find one line. The cap exists so
 * a line at an early offset in a `gate.jsonl` that only grows (`beacons/` is
 * invisible to retention) never costs more than this many bytes to read,
 * however large the file has grown since — modeled on the same bound this
 * issue's own round 3 fixed the whole-file read for, corrected in round 4
 * (see the module docblock for why `readBeaconLines`'s offset-to-EOF shape
 * does not transfer here: it is a tail reader, this is a one-line reader at a
 * known, possibly early, offset).
 *
 * **What it is generous against, stated as a measurement rather than a
 * flourish (round 5's review).** This docblock claimed "roughly two orders of
 * magnitude", which was wrong against every reading of the question, so here
 * are the three that matter:
 *
 * - **What `scripts/gate.sh` actually emits.** `emit_gate_verdict`'s keys are
 *   `v`, `at`, `writer`, `kind`, `lane` (capped at 256 by
 *   `beaconReceivedPayloadSchema`), `held`, `reason` (one member of
 *   `GATE_VERDICT_VOCAB`, `scripts/gate.sh:45` — longest is `timing-regression`
 *   / `off-boundary-file`, 17 bytes), `outputDigest` (64 hex) and
 *   `loadBatches`. All ASCII, so a realistic longest line is **471 bytes** and
 *   this cap is **~17x** that — a bit over ONE order of magnitude, not two.
 *   That 471 assumes a two-digit `loadBatches`, and the assumption is the
 *   interesting part: see the third bullet.
 * - **What the schema permits, for a lane.** JSON escaping is what breaks the
 *   ASCII assumption, and it is not hypothetical: `emit_gate_verdict` builds
 *   the line with `json.dumps`, whose `ensure_ascii` default is `True`, so
 *   every non-ASCII character in a branch name is emitted as `\uXXXX`. A
 *   `lane` of 256 such units serializes to 1,536 bytes, giving a
 *   schema-valid line of ~1,750 bytes — only **~4.7x** under the cap.
 * - **What the schema permits, at all: no bound whatsoever, from TWO fields.**
 *   `gateVerdictPayloadSchema.reason` is `nonEmptyString` with no `.max()`,
 *   and `loadBatches` is `z.number().int().nonnegative()` — also unbounded
 *   (`packages/core/src/events/gate.ts`). So a schema-valid verdict line has
 *   no upper size at all and no multiple of this cap could cover it.
 *
 *   `loadBatches` is why the first bullet says "a realistic longest line"
 *   rather than "the longest": the ASCII figure moves with that integer's
 *   digit count — 470 at one digit, 471 at two, 472 at three — so even the
 *   "maximum ASCII line" is a function of an unbounded field rather than a
 *   constant. Round 6's two seats each independently computed 471 against a
 *   `~472` written here, and chasing that one byte is what surfaced this.
 *
 *   Re-derive rather than trusting these figures, and do it in **Python** —
 *   `emit_gate_verdict` builds the line with `json.dumps`, and JS semantics
 *   give a different answer for the escaped-lane case above, because
 *   `JSON.stringify` does not escape U+FFFF and returns 983 bytes where
 *   `json.dumps` returns 1,751.
 *
 * So this is a bound on **this reader**, deliberately, and never a claim that
 * a line cannot exceed it — which is exactly why exceeding it is a named,
 * tested refusal reason of its own rather than a case treated as impossible.
 */
export const MAX_GATE_VERDICT_LINE_BYTES = 8192

export interface DeriveGateVerdictOptions {
  /** The repo whose beacon directory the sidecar lives under — the same input `beaconDirFor` takes at the collector. */
  repoPath: string
  /** Overrides the instrument's data root; the same knob `BeaconCollectorConfig` exposes, for tests. */
  dataRoot?: string
  /** A fresh id for the derived event — this derivation mints no ids of its own, the same contract `createEvent` already has. */
  id: string
}

export async function deriveGateVerdict(
  beacon: EventOf<'beacon.received'>,
  options: DeriveGateVerdictOptions,
): Promise<GateVerdictDerivation> {
  const { payload } = beacon
  if (payload.writer !== 'gate' || payload.kind !== 'gate.verdict') {
    return { outcome: 'not-a-gate-verdict-beacon' }
  }
  if (payload.lane === null) {
    return { outcome: 'refused', reason: 'beacon has no lane — no handle to attribute the verdict to' }
  }

  // Lexical rejection first, cheap and before any filesystem call: `file` is
  // documented as a basename, never a path (BeaconSnapshot in
  // collectors/beacon/types.ts), but a replayed recording is untrusted input
  // (the sibling case this derivation exists for) — `.` and `..` are the two
  // values `path.basename()` returns UNCHANGED (verified: `path.basename('..')
  // === '..'`), so a basename-equality check alone does not catch them.
  if (payload.file === '.' || payload.file === '..' || payload.file.includes('/') || payload.file.includes('\\')) {
    return { outcome: 'refused', reason: `beacon names a sidecar path, not a file: ${payload.file}` }
  }

  const dir = beaconDirFor(options.repoPath, options.dataRoot)
  const filePath = path.join(dir, payload.file)

  // Containment, not just the lexical check above: `stat`/`open` FOLLOW a
  // symlink, so a plain basename that is itself a symlink pointing outside
  // the beacon directory would otherwise resolve there silently.
  // `canonicalize`/`isInside` are the repo's own shared symlink-escape
  // primitive (`paths/containment.ts`, #217/#228/#299/#401) — reused rather
  // than re-hand-rolled, because a second copy of this exact check is
  // exactly the failure mode that module's own docblock names: the next
  // hardening lands in whichever copy the author was looking at, and the
  // other one keeps the hole. Neither `dir` nor `filePath` needs to exist
  // yet for this to answer correctly — `canonicalize` walks up to the
  // nearest real ancestor either way — so a not-yet-created beacon
  // directory (the ordinary state; see `collectors/beacon/collector.ts`)
  // still resolves consistently and falls through to the ENOENT below.
  let realFile: string
  try {
    realFile = canonicalize(filePath)
  } catch (error) {
    return { outcome: 'refused', reason: `sidecar ${payload.file} could not be resolved: ${String(error)}` }
  }
  if (!isInside(dir, realFile)) {
    return { outcome: 'refused', reason: `sidecar ${payload.file} resolves outside the beacon directory` }
  }

  let size: number
  try {
    const info = await stat(realFile)
    if (!info.isFile()) {
      return { outcome: 'refused', reason: `sidecar ${payload.file} is not a regular file` }
    }
    size = info.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { outcome: 'refused', reason: `sidecar ${payload.file} is missing` }
    }
    return { outcome: 'refused', reason: `sidecar ${payload.file} could not be read: ${String(error)}` }
  }

  // Absent, empty, or shorter than the offset all land here — one answer for
  // all three, per the sibling case this issue names: the record outlives
  // the files beside it, and a replay that never carried the beacons
  // directory must refuse the same way a pruned one does.
  if (size <= payload.offset) {
    return {
      outcome: 'refused',
      reason: `sidecar ${payload.file} (${size} bytes) does not reach the recorded offset ${payload.offset}`,
    }
  }

  // Bounded read: a window of at most MAX_GATE_VERDICT_LINE_BYTES starting at
  // the recorded offset, never "offset to end of file" — see the module
  // docblock for why the tail reader's shape does not transfer here.
  const remaining = size - payload.offset
  const windowLength = Math.min(remaining, MAX_GATE_VERDICT_LINE_BYTES)
  const buffer = Buffer.alloc(windowLength)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(realFile, 'r')
  } catch (error) {
    return { outcome: 'refused', reason: `sidecar ${payload.file} could not be read: ${String(error)}` }
  }
  let bytesRead: number
  try {
    // Round 5's review: `bytesRead` is the only honest measure of what this
    // window actually holds. `size` came from a `stat` that has already
    // happened, and the sidecar is an append-target another process owns, so
    // the file can be replaced or truncated between that `stat` and this
    // `read` — see the newline classification below, which used to reach for
    // the stale `size` and misreport a truncated file as an over-long line.
    ;({ bytesRead } = await handle.read(buffer, 0, windowLength, payload.offset))
  } catch (error) {
    // Round 4's review found this uncaught: a real read fault (EIO, a
    // failing network mount) threw straight out of a function this module's
    // own docblock promises never throws. `poll-loop.ts`'s recording loop
    // has no per-event try around this call, so an uncaught throw here
    // would have aborted the rest of that tick's batch and, per ADR-0029's
    // own comment on that loop, re-derived the WHOLE batch every tick
    // thereafter for as long as the fault persists — a bad sector turning a
    // landing gate into a poll loop that never advances again.
    return { outcome: 'refused', reason: `sidecar ${payload.file} could not be read: ${String(error)}` }
  } finally {
    // Round 5's review found the SIBLING of round 4's finding, one line
    // below the fix for it: `close()` rejects too (EIO on a failing mount,
    // and any fault the kernel defers to close), and a rejection raised in a
    // `finally` REPLACES the value the `try`/`catch` was returning — so a
    // close fault escaped this function as a rejected promise, past both
    // catches, breaking the same no-throw contract round 4 restored and
    // reaching the same unguarded poll-loop seam by the same route.
    //
    // Swallowed rather than turned into a refusal, and the asymmetry with
    // the read above is deliberate: by here the bytes are already in
    // `buffer`, and they are about to be checked against
    // `beacon.received.digest`, which is what actually establishes that they
    // are the recorded line. A verdict proven by that digest is not made
    // less true by the descriptor failing to close afterwards, so refusing
    // here would discard a provably-good verdict over a fault that costs us
    // nothing but the descriptor. A read fault is the opposite case: it
    // means we never got the bytes at all.
    try {
      await handle.close()
    } catch {
      // Deliberately empty — see above. What happens to the descriptor after
      // a failed close is unspecified by POSIX (Linux releases it; the
      // portable answer is that retrying is not safe either), so there is
      // nothing further this function can usefully do about it. The only
      // alternative on offer is a derivation that throws, which is the thing
      // the contract forbids.
    }
  }

  // Classified from `bytesRead`, never from `size`: `windowLength` is what we
  // ASKED for and `size` is what `stat` saw before the read, so a file
  // truncated in between satisfies neither. The distinction this makes is a
  // diagnostic one — both branches refuse and neither yields a verdict — but
  // a wrong reason sends the reader to the wrong cause, which is the whole
  // value the two separate messages were added for.
  //
  // **`newline >= bytesRead` is deliberately unreachable TODAY, and is kept
  // on purpose — do not delete it as dead code, and do not make the alloc
  // below it `allocUnsafe`.** Round 6's review executed exactly that
  // deletion and all 31 tests stayed green, which is true and is the point:
  // the disjunct is load-bearing only against the buffer it is given.
  // `Buffer.alloc` ZERO-fills, so the bytes past `bytesRead` are `0x00` and
  // `indexOf(0x0a)` cannot match there. `Buffer.allocUnsafe` does not
  // zero-fill — it hands back whatever was in the pool — so under it a stale
  // `0x0a` left by an earlier tenant would be found past the bytes actually
  // read, and this derivation would hash a "line" assembled partly from
  // another allocation's residue. The digest check downstream would refuse
  // it, so the failure is a wrong REASON rather than a forged verdict; the
  // disjunct is what keeps it from being either. It costs one comparison,
  // and the two changes that would arm it (swapping the alloc, or reading
  // into a reused buffer) are both the kind of change someone makes for
  // performance without reading this far.
  const newline = buffer.indexOf(0x0a, 0)
  if (newline === -1 || newline >= bytesRead) {
    if (bytesRead >= MAX_GATE_VERDICT_LINE_BYTES) {
      // A full window came back with no newline in it: the line genuinely
      // exceeds what this derivation will read, whatever the file's size is
      // now.
      return {
        outcome: 'refused',
        reason: `sidecar ${payload.file} has no newline within ${MAX_GATE_VERDICT_LINE_BYTES} bytes of offset ${payload.offset} — the line exceeds the bound this derivation reads`,
      }
    }
    // A short read, or a full-but-under-the-cap window with no terminator:
    // the file does not carry a complete line at this offset.
    return {
      outcome: 'refused',
      reason: `sidecar ${payload.file} is truncated — no line terminates at offset ${payload.offset}`,
    }
  }

  const lineText = buffer.toString('utf8', 0, newline)
  const digest = createHash('sha256').update(lineText, 'utf8').digest('hex')
  if (digest !== payload.digest) {
    return {
      outcome: 'refused',
      reason: `sidecar ${payload.file} line at offset ${payload.offset} does not match its recorded digest — altered since it was recorded`,
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(lineText)
  } catch {
    return {
      outcome: 'refused',
      reason: `sidecar ${payload.file} line at offset ${payload.offset} is not valid JSON despite matching its digest`,
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { outcome: 'refused', reason: `sidecar ${payload.file} line at offset ${payload.offset} is not a JSON object` }
  }
  const line = raw as Record<string, unknown>

  const candidate: Record<string, unknown> = {
    handle: payload.lane,
    held: line.held,
    reason: line.reason,
    digest: line.outputDigest,
  }
  if (line.loadBatches !== undefined) candidate.loadBatches = line.loadBatches

  const parsed = gateVerdictPayloadSchema.safeParse(candidate)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    return { outcome: 'refused', reason: `sidecar ${payload.file} line does not carry a well-formed verdict — ${detail}` }
  }

  return { outcome: 'derived', event: createEvent('gate.verdict', parsed.data, { id: options.id, ts: beacon.ts }) }
}
