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
  if (info.size <= offset) return { lines: [], nextOffset: offset, lastWriteTs }

  const length = info.size - offset
  const buffer = Buffer.alloc(length)
  const handle = await open(filePath, 'r')
  try {
    await handle.read(buffer, 0, length, offset)
  } finally {
    await handle.close()
  }

  const text = buffer.toString('utf8')
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) return { lines: [], nextOffset: offset, lastWriteTs }

  const lines = text
    .slice(0, lastNewline)
    .split('\n')
    .filter((line) => line.length > 0)

  return { lines, nextOffset: offset + lastNewline + 1, lastWriteTs }
}
