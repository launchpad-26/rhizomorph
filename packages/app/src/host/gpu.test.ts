import { describe, expect, it } from 'vitest'
import {
  GPU_ENV_MARKER,
  gpuAdapterLine,
  gpuPlan,
  gpuProcessGoneLine,
  needsGpuRelaunch,
  WEBGL_ADAPTER_PROBE,
  WSL_GPU_SWITCHES,
  WSL_LIB_DIR,
} from './gpu.js'

const WSL = { platform: 'linux', env: {}, hasWslLib: true } as const

describe('the GPU plan', () => {
  it('routes WSL through d3d12 with exactly the proven switch set', () => {
    const plan = gpuPlan(WSL)
    expect(plan.wsl).toBe(true)
    expect(plan.env['GALLIUM_DRIVER']).toBe('d3d12')
    expect(plan.env['LD_LIBRARY_PATH']).toBe(WSL_LIB_DIR)
    // Verbatim from the rigs, nothing speculative added: a haunted flag set is
    // how a working configuration stops being explicable.
    expect(plan.switches).toEqual(WSL_GPU_SWITCHES)
    expect(plan.switches).toEqual(['enable-gpu-rasterization', 'ignore-gpu-blocklist'])
    expect(plan.note).toContain('d3d12')
  })

  it('is the empty plan on every platform that is not WSL — structurally incapable of touching them', () => {
    for (const input of [
      { platform: 'darwin', env: {}, hasWslLib: false },
      { platform: 'win32', env: {}, hasWslLib: false },
      { platform: 'linux', env: {}, hasWslLib: false }, // plain Linux: real /dev/dri, no meddling
      { platform: 'darwin', env: {}, hasWslLib: true }, // nonsense combination stays inert
    ]) {
      const plan = gpuPlan(input)
      expect(plan.wsl).toBe(false)
      expect(plan.env).toEqual({})
      expect(plan.switches).toEqual([])
    }
  })

  it("keeps an operator's own GALLIUM_DRIVER — theirs, not ours", () => {
    const plan = gpuPlan({ ...WSL, env: { GALLIUM_DRIVER: 'zink' } })
    expect(plan.env['GALLIUM_DRIVER']).toBeUndefined()
    // The library path is still supplied; the driver choice is what was theirs.
    expect(plan.env['LD_LIBRARY_PATH']).toBe(WSL_LIB_DIR)
  })

  it('treats an empty GALLIUM_DRIVER as unset rather than as a choice', () => {
    expect(gpuPlan({ ...WSL, env: { GALLIUM_DRIVER: '' } }).env['GALLIUM_DRIVER']).toBe('d3d12')
  })

  it('prepends the WSL lib dir to an existing LD_LIBRARY_PATH', () => {
    const plan = gpuPlan({ ...WSL, env: { LD_LIBRARY_PATH: '/opt/lib:/usr/local/lib' } })
    expect(plan.env['LD_LIBRARY_PATH']).toBe(`${WSL_LIB_DIR}:/opt/lib:/usr/local/lib`)
  })

  it('is idempotent: a path already listing the dir is left alone', () => {
    const plan = gpuPlan({ ...WSL, env: { LD_LIBRARY_PATH: `/opt/lib:${WSL_LIB_DIR}` } })
    expect(plan.env['LD_LIBRARY_PATH']).toBeUndefined()
  })

  it('matches whole path-list members, not substrings', () => {
    // `/usr/lib/wsl/lib-extra` contains the dir as a substring and must not
    // count as already-present.
    const plan = gpuPlan({ ...WSL, env: { LD_LIBRARY_PATH: '/usr/lib/wsl/lib-extra' } })
    expect(plan.env['LD_LIBRARY_PATH']).toBe(`${WSL_LIB_DIR}:/usr/lib/wsl/lib-extra`)
  })
})

describe('the re-exec decision', () => {
  it('relaunches when the plan carries env and the marker is absent — the zygote already missed it', () => {
    const plan = gpuPlan(WSL)
    expect(needsGpuRelaunch(plan, {})).toBe(true)
  })

  it('never relaunches twice — the marker is the terminator', () => {
    const plan = gpuPlan(WSL)
    expect(needsGpuRelaunch(plan, { RHIZOMORPH_GPU_ENV_APPLIED: '1' })).toBe(false)
    expect('RHIZOMORPH_GPU_ENV_APPLIED').toBe(GPU_ENV_MARKER)
  })

  it('never relaunches when the env is already right at the seam — a wrapper or dev shell that set it', () => {
    const env = { GALLIUM_DRIVER: 'd3d12', LD_LIBRARY_PATH: WSL_LIB_DIR }
    const plan = gpuPlan({ ...WSL, env })
    // The plan's env delta is empty, so there is nothing a re-exec would carry.
    expect(Object.keys(plan.env)).toHaveLength(0)
    expect(needsGpuRelaunch(plan, env)).toBe(false)
  })

  it('never relaunches off WSL — the empty plan cannot ask for it', () => {
    const plan = gpuPlan({ platform: 'darwin', env: {}, hasWslLib: false })
    expect(needsGpuRelaunch(plan, {})).toBe(false)
  })
})

describe('the GPU-process-gone line', () => {
  it('speaks law 12 for a dead GPU process: the fact, the cost, what is unaffected', () => {
    const line = gpuProcessGoneLine({ type: 'GPU', reason: 'crashed', exitCode: 139 })
    expect(line).toContain('GPU process died')
    expect(line).toContain('crashed')
    expect(line).toContain('139')
    expect(line).toContain('unaffected')
  })

  it('says nothing for every other child — the utility and renderer processes are not its business', () => {
    expect(gpuProcessGoneLine({ type: 'Utility', reason: 'killed' })).toBeNull()
    expect(gpuProcessGoneLine({})).toBeNull()
  })

  it('survives a detail object with nothing in it', () => {
    expect(gpuProcessGoneLine({ type: 'GPU' })).toContain('unknown')
  })
})

describe('the adapter line', () => {
  it('reports a real adapter plainly', () => {
    const line = gpuAdapterLine('ANGLE (Microsoft Corporation, D3D12 (Intel(R) Iris(R) Xe Graphics), OpenGL 4.1)')
    expect(line).toContain('gpu adapter — ANGLE')
    expect(line).not.toContain('software')
  })

  it("names a software rasteriser in the rigs' own terms — the signal the env did not arrive", () => {
    const line = gpuAdapterLine('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))')
    expect(line).toContain('software rasteriser')
    expect(line).toContain('frame budget')
  })

  it('a page with no WebGL2 context reads as none — the same fact the scene answers with its error state', () => {
    for (const shape of [null, undefined, 42, '']) {
      const line = gpuAdapterLine(shape)
      expect(line).toContain('none')
      expect(line).toContain('falls to its list')
    }
  })

  it('the probe is self-contained page code: no DOM attachment, no imports, null on any failure', () => {
    // It runs via executeJavaScript in the real page, so it must be an
    // expression that evaluates alone. Asserted structurally: an IIFE that
    // never touches document.body and catches everything.
    expect(WEBGL_ADAPTER_PROBE.trim().startsWith('(() =>')).toBe(true)
    expect(WEBGL_ADAPTER_PROBE).toContain("getContext('webgl2')")
    expect(WEBGL_ADAPTER_PROBE).toContain('UNMASKED_RENDERER_WEBGL')
    expect(WEBGL_ADAPTER_PROBE).toContain('catch')
    expect(WEBGL_ADAPTER_PROBE).not.toContain('document.body')
    expect(WEBGL_ADAPTER_PROBE).not.toContain('appendChild')
  })
})
