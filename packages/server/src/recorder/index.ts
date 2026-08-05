/**
 * THE RECORDER — the instrument's own writing hand, behind its own module
 * boundary (prd16 ruling 6, framed on the council's advice while the wall was
 * open). Everything that writes a *recording* lives here: the session log
 * writer, the recorder that fans one event out to the log and the live
 * stream, and rotation (prd16 ruling 2). Transcript capture (prd16 ruling 3)
 * lands here next.
 *
 * No process split, today and until a prd rules otherwise: one binary, one
 * recorder object. The boundary is what has value now — `namespace-law.test.ts`
 * asserts every write path behind it lands under the instrument's own data
 * directory and nowhere else, and that rotation is reachable only from an
 * explicit operator command.
 */
export { SessionRecorder, type SessionRecorderOptions } from './session-recorder.js'
export {
  SessionLogWriter,
  dropTrailingPartialLine,
  type SessionLogWriterOptions,
} from './session-log-writer.js'
export {
  closeCurrentSession,
  nextSessionStart,
  openNextSession,
  rotateSession,
  type ClosedSession,
  type OpenedSession,
  type Rotation,
  type RotateSessionOptions,
} from './rotate.js'
