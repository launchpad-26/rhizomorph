/**
 * THE GPU PLAN (prd-34 ruling 1's "the SPA ships unmodified", applied to the
 * one place the shell can break it) — the decision, pure.
 *
 * ## What was wrong
 *
 * Under WSLg there is no `/dev/dri`; the GPU arrives as `/dev/dxg` plus the
 * userspace in `/usr/lib/wsl/lib` (libd3d12), and Chromium only reaches it as
 * a real adapter when Mesa is told to use the d3d12 Gallium driver. The
 * repo's own measurement rigs know this — `research/spikes/renderer/run.mjs`
 * and `scene/parity/capture.mjs` both launch Chromium with
 * `GALLIUM_DRIVER=d3d12`, `LD_LIBRARY_PATH=/usr/lib/wsl/lib` and the two
 * switches below, and both HARD-REFUSE any run whose renderer names a
 * software rasteriser. The parity capture proves the full scene renders on
 * this class of machine through `ANGLE … D3D12`.
 *
 * The shell set none of it. So the packaged instrument's WebGL2 context came
 * up software-or-nothing, the scene drew nothing, and no unit test could see
 * it — the exact "panel is there, none of the rendering" a person reported
 * from the first real first-run.
 *
 * ## Why a pure module
 *
 * `entry.ts` is deliberately the only file in this package that imports
 * `electron`; everything that could be got wrong lives here, pure and tested
 * (`signingPlan` and `loginItemPlan` are the models). The plan is computed
 * from three facts the caller passes in, so every branch — WSL, plain Linux,
 * mac, Windows, an operator's own GALLIUM_DRIVER override — is a unit test
 * rather than a hope.
 *
 * ## What is deliberately NOT here
 *
 * No `--enable-unsafe-swiftshader`, no software-WebGL fallback of any kind.
 * The repo refuses software renderers as a matter of law in both measurement
 * rigs, SwiftShader cannot hold the frame budget at fleet scale, and prd-36
 * S1's fall-to-list is the honest answer when no real GPU exists — a silent
 * software organism would be a slow lie where an honest floor exists.
 */

export interface GpuPlan {
  /** True when this is Linux under WSL — the one environment the plan changes. */
  wsl: boolean
  /** Environment entries to apply before Chromium's GPU process spawns. */
  env: Record<string, string>
  /** Chromium switches to append before `app.whenReady`. */
  switches: readonly string[]
  /** One line for stderr saying what was decided and why — the shell's own honesty habit. */
  note: string
}

export interface GpuPlanInput {
  /** `process.platform`. */
  platform: NodeJS.Platform | string
  /** `process.env` — read for GALLIUM_DRIVER and LD_LIBRARY_PATH, never mutated here. */
  env: Readonly<Record<string, string | undefined>>
  /** `existsSync('/usr/lib/wsl/lib')` — the same fact the repo's rigs key on. */
  hasWslLib: boolean
}

/** Where WSLg keeps the d3d12 userspace. The trigger AND the library path — one fact, used twice. */
export const WSL_LIB_DIR = '/usr/lib/wsl/lib'

/**
 * The proven switch set from the repo's own rigs, verbatim and nothing more.
 * Speculative flags are how a working configuration becomes a haunted one.
 */
export const WSL_GPU_SWITCHES: readonly string[] = ['enable-gpu-rasterization', 'ignore-gpu-blocklist']

/** The refusal regex both measurement rigs use. Reused verbatim so "software" means the same thing everywhere. */
export const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|software/i

export function gpuPlan(input: GpuPlanInput): GpuPlan {
  const wsl = input.platform === 'linux' && input.hasWslLib
  if (!wsl) {
    // Structurally incapable of affecting mac, Windows or plain Linux: the
    // empty plan is the plan.
    return { wsl: false, env: {}, switches: [], note: '' }
  }

  const env: Record<string, string> = {}

  // Only if unset: an operator who exported their own driver choice (or is
  // steering adapters with MESA_D3D12_DEFAULT_ADAPTER_NAME) keeps it.
  if (input.env['GALLIUM_DRIVER'] === undefined || input.env['GALLIUM_DRIVER'] === '') {
    env['GALLIUM_DRIVER'] = 'd3d12'
  }

  // Prepend, idempotently: an LD_LIBRARY_PATH that already lists the WSL lib
  // directory (exact path-list member, not substring) is left alone.
  const current = input.env['LD_LIBRARY_PATH'] ?? ''
  const members = current.split(':').filter((entry) => entry !== '')
  if (!members.includes(WSL_LIB_DIR)) {
    env['LD_LIBRARY_PATH'] = current === '' ? WSL_LIB_DIR : `${WSL_LIB_DIR}:${current}`
  }

  return {
    wsl: true,
    env,
    switches: WSL_GPU_SWITCHES,
    note: 'rhizomorph: WSL detected — routing the GPU through d3d12 so the scene reaches a real adapter (the configuration the parity capture proves)',
  }
}

/**
 * One law-12 line for a dead GPU process, or null for every other child.
 *
 * Chromium restarts a crashed GPU process on its own; what the shell owes the
 * operator is the fact, what it may cost, and what is unaffected — on stderr,
 * the one channel that exists when the picture is the thing that broke.
 */
export function gpuProcessGoneLine(details: { type?: string; reason?: string; exitCode?: number }): string | null {
  if (details.type !== 'GPU') return null
  const reason = details.reason ?? 'unknown'
  const code = details.exitCode === undefined ? '' : ` (exit ${details.exitCode})`
  return `rhizomorph: the GPU process died — ${reason}${code} — the organism may fall to its list; the panels, the watcher and the tray are unaffected`
}

/**
 * The adapter, reported rather than assumed.
 *
 * `app.getGPUInfo('basic')` has no stable published shape, so the renderer is
 * dug out defensively; a shape this can't read is itself reported rather than
 * swallowed. If the renderer names a software rasteriser, the line says so in
 * the rigs' own terms — that is the signal that the env-timing risk named in
 * the plan has fired, and the launch-seam fallback is due.
 */
export function gpuAdapterLine(info: unknown): string {
  const renderer = rendererOf(info)
  if (renderer === null) {
    return 'rhizomorph: gpu adapter — unknown (getGPUInfo returned no readable renderer)'
  }
  if (SOFTWARE_RENDERER_RE.test(renderer)) {
    return `rhizomorph: gpu adapter — ${renderer} — a software rasteriser: the organism will not hold a frame budget, and on WSL this means the d3d12 env did not reach the GPU process`
  }
  return `rhizomorph: gpu adapter — ${renderer}`
}

function rendererOf(info: unknown): string | null {
  if (info === null || typeof info !== 'object') return null
  const aux = (info as { auxAttributes?: unknown }).auxAttributes
  if (aux === null || typeof aux !== 'object') return null
  const renderer = (aux as { glRenderer?: unknown }).glRenderer
  return typeof renderer === 'string' && renderer !== '' ? renderer : null
}
