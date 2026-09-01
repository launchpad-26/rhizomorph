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
  RETARGET_OR_ROTATION_IN_FLIGHT_MESSAGE,
  retargetSession,
  RetargetInFlightError,
  rotateSession,
  RotationRefusedError,
  type ClosedSession,
  type CloseSessionOptions,
  type OpenedSession,
  type OpenSessionOptions,
  type RetargetBoundary,
  type RetargetSessionOptions,
  type Rotation,
  type RotateSessionOptions,
  // `performRetarget`, `beginRetargetBoundary` and `reserveInFlightForTest`
  // are deliberately absent — they are the doors #87's rotation-entry law
  // guards, and the barrel is not "everything rotate.ts exports" (see the
  // completeness guard in `namespace-law.test.ts`, and rotate.ts's own doc
  // comment on each of the three).
} from './rotate.js'
