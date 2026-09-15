import type { AdapterCapabilities } from '@rhizomorph/core'

/**
 * What `doctor` and `/connect` say about the process witness — prd-57 ruling 2.
 *
 * Three states, and the third is the one this file exists for. The beacon
 * organ's row (prd-27 ruling 3, #218) already established that a collector's
 * manifest may be a function of the FOLD rather than a static declaration; this
 * adds the case that organ never had, a platform where the reader is **not
 * built at all**.
 *
 * That third state must not read as "absent" in the sense the other rows use —
 * "the tool is not installed, go and install it" — because there is nothing the
 * operator can install. What is missing is a capture, and the remedy is
 * therefore the capture command. prd-15 ruling 7: a platform leg lands behind a
 * capture, never from a man page.
 */

/** The one command that makes an unbuilt leg buildable, per platform. */
function captureRemedy(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'capture a real table while an agent runs — `ps -axo pid=,ppid=,lstart=,time=,rss=,command=` and `lsof -a -p <pid> -d cwd -Fn` — and commit it under collectors/process/fixtures (see its CAPTURE.md)'
    case 'win32':
      return 'capture a real table while an agent runs — `Get-CimInstance Win32_Process | ConvertTo-Json` — and commit it under collectors/process/fixtures (see its CAPTURE.md)'
    default:
      return 'name a read-only way to read this platform’s process table and land it behind a capture (see collectors/process/fixtures/CAPTURE.md)'
  }
}

export function processWitnessCapabilitiesFor(actorCount: number, platform: NodeJS.Platform): AdapterCapabilities {
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
