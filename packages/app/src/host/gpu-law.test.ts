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
  it('entry computes the plan, applies the switches, and delivers env through the SEAM, not process.env', () => {
    expect(entry).toContain('gpuPlan({ platform: process.platform, env: process.env')
    expect(entry).toContain('app.commandLine.appendSwitch(gpuSwitch)')
    // Measured on this box: env mutated in-script → llvmpipe; the same env at
    // the launch seam → the real D3D12 adapter. Linux forks the zygote before
    // this script runs, so an in-script mutation is a silent no-op for the GPU
    // process — the exact shape of failure this law exists to keep out.
    expect(entry).not.toContain('Object.assign(process.env, gpu.env)')
    expect(entry).toContain('needsGpuRelaunch(gpu, process.env)')
    expect(entry).toContain('GPU_ENV_MARKER]:')
  })

  it('the re-exec decides BEFORE the single-instance lock — after would race its own child for it', () => {
    const relaunch = entry.indexOf('if (relaunchingForGpuEnv)')
    const lock = entry.indexOf('app.requestSingleInstanceLock()')
    expect(relaunch).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(-1)
    expect(relaunch).toBeLessThan(lock)
    // Detached and unref'd, or the parent's exit takes the working child down.
    expect(entry).toContain('detached: true')
    expect(entry).toContain('.unref()')
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

  it('the adapter is reported from the PAGE, not assumed — the same surface the scene draws on', () => {
    // getGPUInfo ('basic' and 'complete' alike) returns no readable renderer
    // on this Electron under WSLg — measured, not guessed — so the probe runs
    // in the loaded page and reads UNMASKED_RENDERER_WEBGL, the parameter both
    // measurement rigs assert against.
    expect(entry).toContain("once('did-finish-load'")
    expect(entry).toContain('executeJavaScript(WEBGL_ADAPTER_PROBE')
    expect(entry).toContain('gpuAdapterLine(renderer)')
  })

  it('the decision module never imports electron — decisions stay pure and testable', () => {
    expect(gpu).not.toContain("from 'electron'")
  })
})
