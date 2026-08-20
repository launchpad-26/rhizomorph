import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The GPU plan is applied, applied EARLY, and stays pure.
 *
 * The failure this law exists for is silent and environmental: a shell that
 * forgot to apply the plan (or applied it after Chromium's GPU process
 * spawned) boots, passes every unit test, and draws an empty organism on
 * exactly the machines prd-34 ships to. No behaviour test can see that from
 * jsdom, so — like `bridge-law` and `capability-law` — this reads the source
 * of the one file allowed to import electron and pins the wiring's shape.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, '..', 'main', 'entry.ts')
const GPU = path.join(HERE, 'gpu.ts')

const entry = readFileSync(ENTRY, 'utf8')
const gpu = readFileSync(GPU, 'utf8')

describe('gpu law: the plan is applied before Chromium can need it', () => {
  it('entry computes the plan and applies env and switches', () => {
    expect(entry).toContain('gpuPlan({ platform: process.platform, env: process.env')
    expect(entry).toContain('Object.assign(process.env, gpu.env)')
    expect(entry).toContain('app.commandLine.appendSwitch(gpuSwitch)')
  })

  it('the switches are appended before whenReady — after is too late for the GPU process', () => {
    const applied = entry.indexOf('app.commandLine.appendSwitch')
    const ready = entry.indexOf('app.whenReady()')
    expect(applied).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(-1)
    expect(applied).toBeLessThan(ready)
  })

  it('a dead GPU process is reported through the one formatter', () => {
    expect(entry).toContain("app.on('child-process-gone'")
    expect(entry).toContain('gpuProcessGoneLine(details)')
  })

  it('the adapter is reported after boot, not assumed', () => {
    expect(entry).toContain("app.getGPUInfo('basic')")
    expect(entry).toContain('gpuAdapterLine(info)')
  })

  it('the decision module never imports electron — decisions stay pure and testable', () => {
    expect(gpu).not.toContain("from 'electron'")
  })
})
