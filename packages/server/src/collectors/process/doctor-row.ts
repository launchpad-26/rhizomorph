import type { AdapterCapabilities } from '@rhizomorph/core'

/**
 * What `doctor` and `/connect` say about the process witness — prd-57 ruling 2.
 *
 * **Four** states. The beacon organ's row (prd-27 ruling 3, #218) already
 * established that a collector's manifest may be a function of the FOLD rather
 * than a static declaration; the two this file adds are ones that organ never
 * had, and they are not the same absence:
 *
 * 1. `provided` — an actor has been seen.
 * 2. `partial` — the leg reads, and has seen nothing yet.
 * 3. `absent` — **no reader is built for this platform** (macOS today). Not
 *    "absent" in the sense the other rows use it — "the tool is not installed,
 *    go and install it" — because there is nothing the operator can install.
 *    What is missing is a capture, so the remedy is the capture command.
 *    prd-15 ruling 7: a platform leg lands behind a capture, never a man page.
 * 4. `partial` for an entirely different reason — **the leg is built, verified
 *    against a real capture, and structurally cannot do the whole job**
 *    (Windows). Added when that leg landed; see `fixtures/CAPTURE.md` and
 *    `docs/review/2026-09-16-prd57-windows-witness.md`.
 *
 * Collapsing 3 and 4 is the failure this shape exists to prevent: it would tell
 * a Windows operator to go and capture a table that is already committed.
 */

/** The one command that makes an unbuilt leg buildable, per platform. */
function captureRemedy(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'capture a real table while an agent runs — `ps -axo pid=,ppid=,lstart=,time=,rss=,command=` and `lsof -a -p <pid> -d cwd -Fn` — and commit it under collectors/process/fixtures (see its CAPTURE.md)'
    default:
      return 'name a read-only way to read this platform’s process table and land it behind a capture (see collectors/process/fixtures/CAPTURE.md)'
  }
}

export function processWitnessCapabilitiesFor(actorCount: number, platform: NodeJS.Platform): AdapterCapabilities {
  if (platform === 'win32') {
    // A fourth state the beacon organ never needed: the leg IS built and
    // verified against a real capture, and it still cannot do the whole job.
    // `Win32_Process` exposes no working directory, so this platform
    // identifies an agent and cannot say which worktree it is in — and a lane
    // is a PLACE, so an actor with no placement reaches no lane.
    //
    // Reporting this as `absent` would tell an operator to go and capture
    // something that already exists. Reporting it as `provided` would claim a
    // placement nobody has. `partial` with the real reason is the only honest
    // reading, and the remedy is not something the operator does — it is
    // prd-57 ruling 3's join, which arrives with the transcript and hook
    // witnesses in wave 3.
    const reason =
      'Windows identifies an agent process but cannot place it: Win32_Process exposes no working directory, and Windows will not give one for another process without native calls'
    const remedy = 'placement arrives with the transcript and hook join (prd-57 ruling 3); nothing to do here'
    return {
      identity: { level: 'partial', reason, remedy },
      liveness: { level: 'partial', reason, remedy },
      activity: { level: 'partial', reason, remedy },
      attention: { level: 'absent', reason: 'a process table never says a process wants a human' },
      telemetry: { level: 'absent', reason: 'this witness reads the machine; the agent is not told it is watched' },
      cost: { level: 'absent', reason: 'CPU and resident bytes are machine cost, not tokens and not dollars' },
    }
  }

  if (platform !== 'linux') {
    const reason = `no process-table reader is built for ${platform}, so no agent process can be seen here`
    const remedy = captureRemedy(platform)
    return {
      identity: { level: 'absent', reason, remedy },
      liveness: { level: 'absent', reason, remedy },
      activity: { level: 'absent', reason, remedy },
      attention: { level: 'absent', reason: 'a process table never says a process wants a human' },
      telemetry: { level: 'absent', reason: 'this witness reads the machine; the agent is not told it is watched' },
      cost: { level: 'absent', reason: 'CPU and resident bytes are machine cost, not tokens and not dollars' },
    }
  }

  if (actorCount === 0) {
    // The leg IS built and has said nothing. That is not the same fact as
    // having no leg, and collapsing the two would tell an operator to go and
    // capture something on a platform that already works.
    const reason = 'the process witness is reading, and has not seen an agent process in this repo yet'
    const remedy = 'start an agent in a worktree of this repo — no configuration is needed for it to be seen'
    return {
      identity: { level: 'partial', reason, remedy },
      liveness: { level: 'partial', reason, remedy },
      activity: { level: 'partial', reason, remedy },
      attention: { level: 'absent', reason: 'a process table never says a process wants a human' },
      telemetry: { level: 'absent', reason: 'this witness reads the machine; the agent is not told it is watched' },
      cost: { level: 'absent', reason: 'CPU and resident bytes are machine cost, not tokens and not dollars' },
    }
  }

  return {
    identity: { level: 'provided' },
    liveness: { level: 'provided' },
    activity: {
      level: 'partial',
      reason:
        'CPU and resident memory say a process is burning something, never that it is making progress — a wedged agent and a working one look the same here',
    },
    attention: { level: 'absent', reason: 'a process table never says a process wants a human' },
    telemetry: { level: 'absent', reason: 'this witness reads the machine; the agent is not told it is watched' },
    cost: { level: 'absent', reason: 'CPU and resident bytes are machine cost, not tokens and not dollars' },
  }
}
