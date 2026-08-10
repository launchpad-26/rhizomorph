import { open, stat } from 'node:fs/promises'

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
}

/**
 * Reads whatever whole lines have been appended to `filePath` since `offset`.
 * A session JSONL is written line-by-line while the agent is still working,
 * so the bytes after the last `\n` may be a line still being written — those
 * are left unread and picked up whole on a later call once they're complete.
 */
export async function readNewLines(filePath: string, offset: number): Promise<TailResult> {
  const info = await stat(filePath)
  const lastWriteTs = Math.floor(info.mtimeMs)
  // A file smaller than our cursor was truncated or rotated out from under
  // us — the bytes at `offset` no longer exist. Restart from 0 instead of
  // seeking past a byte offset the file can never reach again.
  const readOffset = info.size < offset ? 0 : offset
  if (info.size <= readOffset) return { lines: [], nextOffset: readOffset, lastWriteTs }

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
  if (lastNewline === -1) return { lines: [], nextOffset: readOffset, lastWriteTs }

  const lines = text
    .slice(0, lastNewline)
    .split('\n')
    .filter((line) => line.length > 0)

  return { lines, nextOffset: readOffset + lastNewline + 1, lastWriteTs }
}
