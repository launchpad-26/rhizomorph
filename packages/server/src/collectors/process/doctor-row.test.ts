import type { CapabilityDetail } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { processWitnessCapabilitiesFor } from './doctor-row.js'

/**
 * The four states of the process witness's row, and specifically the two that
 * are easiest to collapse into one another.
 *
 * ADR-0010's whole point is that a declared gap is worth more than a silent
 * one, which makes a gap declared WRONGLY worse than either: it sends an
 * operator to do work that is already done, or claims a capability nobody has.
 */

type DeclaredGap = Extract<CapabilityDetail, { reason: string }>

/**
 * Narrow to the arm that carries prose — asserting rather than casting.
 *
 * `CapabilityDetail` makes `reason` compiler-required on `partial`/`absent`
 * and absent on `provided`: ADR-0010's law stated as a type rather than as a
 * convention an author could skip. So reading a reason has to prove the level
 * is one that HAS a reason, which is a stronger assertion than the cast it
 * replaces — and the type is what taught this test to make it.
 */
function gap(detail: CapabilityDetail): DeclaredGap {
  if (detail.level === 'provided') {
    throw new Error('expected a declared gap; got `provided`, which carries no reason at all')
  }
  return detail
}

describe('macOS: the leg IS built, and it places as well as identifies', () => {
  // Inverted rather than deleted when the capture landed (2026-09-16). This
  // block asserted `absent` and the capture command as its remedy; the fact
  // that changed is visible in the diff, which is the point of inverting.
  const capabilities = processWitnessCapabilitiesFor(0, 'darwin')

  it('reports partial, never absent — the capture exists and is committed', () => {
    // The failure this pins: `absent` would send a macOS operator off to
    // capture `macos-ps.txt`, which is already in this tree.
    expect(capabilities.identity.level).toBe('partial')
    expect(capabilities.liveness.level).toBe('partial')
  })

  it('gives Linux’s remedy — an action that works — and never the capture command', () => {
    expect(gap(capabilities.identity).remedy).toMatch(/start an agent/i)
    expect(gap(capabilities.identity).remedy).not.toMatch(/ps -axo|lsof|CAPTURE\.md/)
  })

  it('reaches PROVIDED once an actor has been seen, which Windows never does', () => {
    // The whole difference between this platform and the one below it. macOS
    // reads a working directory, so an identified actor is a placed actor and
    // the row may honestly say `provided`. Windows cannot and stays `partial`
    // at any actor count.
    expect(processWitnessCapabilitiesFor(3, 'darwin').identity.level).toBe('provided')
    expect(processWitnessCapabilitiesFor(3, 'win32').identity.level).toBe('partial')
  })
})

describe('Windows: the leg IS built, and still cannot place an actor', () => {
  const capabilities = processWitnessCapabilitiesFor(0, 'win32')

  it('reports partial, never absent — the capture exists and is committed', () => {
    // The failure this pins: `absent` would send a Windows operator off to
    // capture `windows-cim.json`, which is already in this tree.
    expect(capabilities.identity.level).toBe('partial')
    expect(capabilities.liveness.level).toBe('partial')
    expect(capabilities.activity.level).toBe('partial')
  })

  it('reports partial, never provided — a placement nobody has must not be claimed', () => {
    expect(capabilities.identity.level).not.toBe('provided')
  })

  it('gives the structural reason, and NOT the missing-capture one', () => {
    expect(gap(capabilities.identity).reason).toMatch(/working directory/i)
    expect(gap(capabilities.identity).reason).toMatch(/Win32_Process/)
    // The two must not read alike: a Windows operator handed a capture command
    // would be told to do work that is already done.
    expect(gap(capabilities.identity).remedy).not.toMatch(/ps -axo|lsof|CAPTURE\.md/)
  })

  it('says the remedy is not the operator’s — it is the hook join, in a later wave', () => {
    expect(gap(capabilities.identity).remedy).toMatch(/ruling 3|nothing to do here/)
  })

  it('stays partial once actors HAVE been seen — identification is not placement', () => {
    // The trap a count-driven row falls into: it would flip this platform to
    // `provided` the moment it identified an agent, claiming a worktree it has
    // never been able to read.
    expect(processWitnessCapabilitiesFor(3, 'win32').identity.level).toBe('partial')
  })
})

describe('Linux: the two states that differ only by what the fold holds', () => {
  it('is partial while reading and having seen nothing — not the same fact as having no leg', () => {
    const capabilities = processWitnessCapabilitiesFor(0, 'linux')
    expect(capabilities.identity.level).toBe('partial')
    // And its remedy is an action that actually works: start an agent.
    expect(gap(capabilities.identity).remedy).toMatch(/start an agent/i)
    expect(gap(capabilities.identity).remedy).not.toMatch(/CAPTURE\.md/)
  })

  it('is provided once an actor has been seen', () => {
    const capabilities = processWitnessCapabilitiesFor(1, 'linux')
    expect(capabilities.identity.level).toBe('provided')
    expect(capabilities.liveness.level).toBe('provided')
  })

  it('never claims progress from CPU, on the platform where everything else works', () => {
    // A wedged agent and a working one burn CPU identically. This is the one
    // gap that stays declared even where the leg is complete.
    const capabilities = processWitnessCapabilitiesFor(1, 'linux')
    expect(capabilities.activity.level).toBe('partial')
    expect(gap(capabilities.activity).reason).toMatch(/wedged/)
  })
})

describe('a platform with no leg at all — the state macOS left', () => {
  const capabilities = processWitnessCapabilitiesFor(0, 'freebsd')

  it('reports absent, and the remedy is to name a strategy and capture it', () => {
    // Nothing here is installable, so the remedy cannot be "go and install
    // something" the way every other doctor row in this repo reads. This arm
    // is still reachable, and this is now the only test that reaches it —
    // without it, `captureRemedy` would be dead code that looked alive.
    expect(capabilities.identity.level).toBe('absent')
    expect(gap(capabilities.identity).remedy).toMatch(/CAPTURE\.md/)
    expect(gap(capabilities.identity).remedy).toMatch(/freebsd/)
  })
})

describe('what no platform ever claims', () => {
  it.each([['linux'], ['darwin'], ['win32']] as const)(
    'refuses attention, telemetry and cost on %s, each with a reason',
    (platform) => {
      for (const actorCount of [0, 4]) {
        const capabilities = processWitnessCapabilitiesFor(actorCount, platform)
        for (const signal of ['attention', 'telemetry', 'cost'] as const) {
          expect(capabilities[signal].level, `${signal} on ${platform}`).toBe('absent')
          expect(gap(capabilities[signal]).reason, `${signal} on ${platform}`).toBeTruthy()
        }
      }
    },
  )

  it('leaves no non-provided signal without a reason, on any platform', () => {
    // ADR-0010 in one assertion, and the one that catches a NEW platform arm
    // added later without prose — which is how this row would quietly start
    // lying again.
    for (const platform of ['linux', 'darwin', 'win32', 'freebsd'] as const) {
      for (const actorCount of [0, 4]) {
        for (const [signal, detail] of Object.entries(processWitnessCapabilitiesFor(actorCount, platform))) {
          if (detail.level === 'provided') continue
          expect(detail.reason, `${signal} on ${platform} (${actorCount} actors)`).toBeTruthy()
        }
      }
    }
  })
})
