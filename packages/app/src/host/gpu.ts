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

/**
 * The marker a re-exec'd process carries, proving the env below arrived at the
 * launch seam rather than being mutated too late.
 *
 * ## Why a re-exec exists at all — measured, not theorised
 *
 * On Linux, Chromium forks its zygote before a single line of the app's own
 * script runs, and the GPU process forks from the zygote — so `process.env`
 * mutation in the main script never reaches it. Measured on this box, in
 * order: env mutated in-script → `ANGLE (Mesa, llvmpipe …)`, a software
 * rasteriser; the same variables at the launch seam (the parent shell) →
 * `ANGLE (Microsoft Corporation, D3D12 (Intel(R) Iris(R) Xe Graphics))`, the
 * real adapter. Same binary, same flags, same machine — only WHERE the env
 * was set differed.
 *
 * So when the plan has env to deliver and this marker is absent, the shell
 * spawns itself once with the env in place and exits before taking the
 * single-instance lock (exiting after would race its own child for the lock
 * and kill it). The child carries the marker, computes an empty env delta,
 * and boots normally. Every other platform, and every WSL launch that already
 * has the env (a wrapper, a dev shell), never re-execs.
 */
export const GPU_ENV_MARKER = 'RHIZOMORPH_GPU_ENV_APPLIED'

/** True when this process must re-exec through the launch seam to deliver the plan's env. */
export function needsGpuRelaunch(plan: GpuPlan, env: Readonly<Record<string, string | undefined>>): boolean {
  return plan.wsl && Object.keys(plan.env).length > 0 && env[GPU_ENV_MARKER] === undefined
}

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
 * The probe the adapter line runs IN THE PAGE, once it has loaded.
 *
 * Measured before choosing this: `app.getGPUInfo('basic')` and `'complete'`
 * both return no readable renderer string on this Electron under WSLg, so a
 * main-process report could only ever say "unknown". The page's own WebGL2
 * context is the truer witness anyway — it is the exact surface the scene
 * draws on, and `UNMASKED_RENDERER_WEBGL` is the same parameter both
 * measurement rigs assert against. Self-contained and side-effect-free: one
 * throwaway canvas, never attached to the DOM.
 */
export const WEBGL_ADAPTER_PROBE = `(() => {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) return null
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    return typeof renderer === 'string' ? renderer : null
  } catch {
    return null
  }
})()`

/**
 * The adapter, reported rather than assumed.
 *
 * Null means the page could not create a WebGL2 context at all — which is the
 * case the scene now answers with S1's error state, so the two lines agree. A
 * software rasteriser is named in the rigs' own terms: that is the signal the
 * env-timing risk named in the plan has fired, and the launch-seam fallback
 * is due.
 */
export function gpuAdapterLine(renderer: unknown): string {
  if (typeof renderer !== 'string' || renderer === '') {
    return 'rhizomorph: gpu adapter — none (the page could not create a WebGL2 context; the organism falls to its list and says so)'
  }
  if (SOFTWARE_RENDERER_RE.test(renderer)) {
    return `rhizomorph: gpu adapter — ${renderer} — a software rasteriser: the organism will not hold a frame budget, and on WSL this means the d3d12 env did not reach the GPU process`
  }
  return `rhizomorph: gpu adapter — ${renderer}`
}
