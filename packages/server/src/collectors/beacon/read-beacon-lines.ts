import { open, stat } from 'node:fs/promises'
import { isRotated, type TailIdentity } from '../sessionlog/tail.js'

/** One complete line as it sat in the file, with the byte offset of its first byte. */
export interface BeaconLine {
  /** The line's bytes as UTF-8 text, without its terminating `\n`. A blank line is `''`. */
  text: string
  /** Byte offset of the line's first byte from the start of the file — with the file's basename, the sidecar coordinate ADR-0036 promises. */
  offset: number
}

export interface BeaconReadResult {
  /** Every complete line newly available since `offset`, oldest first — blank lines included. */
  lines: BeaconLine[]
  /** Byte offset to pass in next time — always the start of the first incomplete line. */
  nextOffset: number
  /** This read's identity — pass back in next time so a rotation can be told apart from growth. */
  identity: TailIdentity
}

/**
 * Reads whatever whole lines have been appended to `filePath` since `offset`,
 * each paired with its own byte offset.
 *
 * The beacon collector does not use `sessionlog/tail.ts`'s `readNewLines` for
 * this, and the difference is the point of this file: that helper drops empty
 * lines before returning them, which is right for a transcript (a blank line
 * carries nothing) and wrong for a beacon file, where every line's byte offset
 * is part of the event contract. Reconstructing offsets by summing the
 * returned lines' lengths put the next beacon's `offset` one byte early for
 * every blank line the helper had swallowed, and the blank line — a malformed
 * beacon, by the line contract — was never reported (#217's verify pass,
 * EXECUTED). Here a blank line is a line: it comes back as `''` at its real
 * offset, the parser refuses it by name, and the following line's offset is
 * where its bytes actually start.
 *
 * Rotation and truncation follow `readNewLines` exactly, through the same
 * `isRotated`: a different inode, or a same-inode shrink below the cursor,
 * restarts the read at byte 0. Bytes after the last `\n` are a line still
 * being written and are left for a later call.
 */
export async function readBeaconLines(filePath: string, offset: number, identity?: TailIdentity): Promise<BeaconReadResult> {
  const info = await stat(filePath)
  const currentIdentity: TailIdentity = { dev: info.dev, ino: info.ino }
  const readOffset = isRotated(identity, currentIdentity) || info.size < offset ? 0 : offset
  if (info.size <= readOffset) return { lines: [], nextOffset: readOffset, identity: currentIdentity }

  const length = info.size - readOffset
  const buffer = Buffer.alloc(length)
  const handle = await open(filePath, 'r')
  try {
    await handle.read(buffer, 0, length, readOffset)
  } finally {
    await handle.close()
  }

  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline === -1) return { lines: [], nextOffset: readOffset, identity: currentIdentity }

  const lines: BeaconLine[] = []
  let start = 0
  while (start <= lastNewline) {
    const end = buffer.indexOf(0x0a, start)
    lines.push({ text: buffer.toString('utf8', start, end), offset: readOffset + start })
    start = end + 1
  }

  return { lines, nextOffset: readOffset + lastNewline + 1, identity: currentIdentity }
}
