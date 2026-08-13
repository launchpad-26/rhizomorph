import { open, stat } from 'node:fs/promises'

/** A path's filesystem identity — same `dev`+`ino` means the same underlying file. */
export interface TailIdentity {
  dev: number
  ino: number
}

/**
 * True when `current` names a different underlying file than `previous` did.
 * Absent `previous` means there is nothing yet to compare against — a file
 * never read before, or a snapshot persisted before this field existed —
 * which is never a rotation, only an unknown.
 */
export function isRotated(previous: TailIdentity | undefined, current: TailIdentity): boolean {
  return previous !== undefined && (previous.dev !== current.dev || previous.ino !== current.ino)
}

export interface TailResult {
  /** Complete lines newly available since `offset`, oldest first. */
  lines: string[]
  /** Byte offset to pass in next time — always the start of the first incomplete line. */
  nextOffset: number
  /**
   * The file's last-write time (epoch ms), from the `stat` this read already
   * had to make — the transcript organ's heartbeat witness (prd15 ruling 1
   * input (b)), at no extra I/O. Reported even when nothing new was read,
   * because "the file moved but no whole line landed" is itself a heartbeat.
   */
  lastWriteTs: number
  /** This read's identity — pass back in next time so a rotation can be told apart from growth. */
  identity: TailIdentity
}

/**
 * Reads whatever whole lines have been appended to `filePath` since `offset`.
 * A session JSONL is written line-by-line while the agent is still working,
 * so the bytes after the last `\n` may be a line still being written — those
 * are left unread and picked up whole on a later call once they're complete.
 *
 * `identity` is the `TailIdentity` a previous call to this same path
 * returned, if any. A same-path rotation (rename-based rotation, a fresh
 * session reusing the path) swaps in a different inode; a byte-count
 * comparison alone cannot tell that apart from ordinary growth once the
 * replacement has already grown past `offset` (#305's follow-up review) —
 * only identity can.
 */
export async function readNewLines(filePath: string, offset: number, identity?: TailIdentity): Promise<TailResult> {
  const info = await stat(filePath)
  const lastWriteTs = Math.floor(info.mtimeMs)
  const currentIdentity: TailIdentity = { dev: info.dev, ino: info.ino }
  // A different inode means `filePath` now names a different file, regardless
  // of size — the bytes at `offset` belong to the file that used to be here,
  // not this one. A same-inode shrink is truncation in place instead; either
  // way the cursor can no longer be trusted and restarts from 0.
  //
  // That symmetry stops at the cursor. `collector.ts`'s `tailProjectDir` resets
  // the FOLD (turnShape, lastUsageRequestId, lane, branch) only when `isRotated`
  // is true, not on a same-inode shrink alone — deliberately, not by omission
  // (#413). `isRotated` is identity-based and by construction never fires on a
  // truncation, so a same-inode shrink always resumes the existing fold. This is
  // NOT covered by a fallback: `nextOffset < prevFile.offset` (collector.ts's
  // spelling of the shrink this function detects as `info.size < offset`) only
  // catches a same-inode replacement that leaves the new file smaller than the
  // old cursor. A same-inode whole-file replacement that grows past the cursor
  // is invisible to both `isRotated` and that size check — it reads as ordinary
  // growth, resumes the existing fold, and silently drops whatever the
  // replacement wrote before the old offset. Safety here rests entirely on the
  // unreachability ruling: every `--resume` observed appends to the file it
  // resumes, and the one mechanism in this codebase that intentionally shortens
  // a transcript (the lab fork spike,
  // `docs/research/2026-08-04-fork-checkpoint-spike.md` Q2) places the
  // truncated copy under a new session id rather than truncating the original
  // in place. If that ever stops holding — including for the grow-past-cursor
  // case above, which no predicate here catches — the fix has to detect the
  // replacement itself (e.g. content-hash the first bytes at the old offset),
  // not widen `isRotated` or the size check.
  const rotated = isRotated(identity, currentIdentity)
  const readOffset = rotated || info.size < offset ? 0 : offset
  if (info.size <= readOffset) return { lines: [], nextOffset: readOffset, lastWriteTs, identity: currentIdentity }

  const length = info.size - readOffset
  const buffer = Buffer.alloc(length)
  const handle = await open(filePath, 'r')
  try {
    await handle.read(buffer, 0, length, readOffset)
  } finally {
    await handle.close()
  }

  const text = buffer.toString('utf8')
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) return { lines: [], nextOffset: readOffset, lastWriteTs, identity: currentIdentity }

  const lines = text
    .slice(0, lastNewline)
    .split('\n')
    .filter((line) => line.length > 0)

  return { lines, nextOffset: readOffset + lastNewline + 1, lastWriteTs, identity: currentIdentity }
}
