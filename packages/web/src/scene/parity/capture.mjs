/**
 * THE PARITY CAPTURE — one seeded frame, both painters, two PNGs and a number.
 *
 * #578 asks for parity to be *evidenced, not asserted*. A painter that draws
 * nothing is the fastest painter there is, and a diff nobody looked at is not
 * evidence, so this draws `parity/scene.ts` twice in one page — once through the
 * canvas 2D painter as it stood before the swap, once through the WebGL2 painter
 * that replaced it — reads both back, and reports where they differ.
 *
 * **The "before" arm is not a copy.** It is `packages/web/src/scene/paint.ts`
 * itself, fetched with `git show` into a scratch directory at run time and
 * deleted afterwards. Nothing of the 2D painter survives in the tree; the
 * comparison reaches back into history for it, which is the only way to compare
 * against something that has been removed.
 *
 * With no `--ref`, the harness **finds the last commit that still had the file**
 * — the parent of the commit that deleted it. That is deliberate rather than
 * tidy: a fixed default of `HEAD` was right for exactly one commit and broke the
 * moment the delete landed, and a parity harness that stops resolving its own
 * baseline is a harness nobody re-runs. This way it keeps working after a rebase,
 * a squash, or a year.
 *
 *     node packages/web/src/scene/parity/capture.mjs            # both arms
 *     node packages/web/src/scene/parity/capture.mjs --ref abc  # a different before
 *
 * Chromium runs **headful**, for the reason `research/spikes/renderer/run.mjs`
 * records: headless on a WSL box falls back to SwiftShader, and a software
 * rasteriser answers every question wrongly and looks like an answer. The run is
 * refused if the WebGL arm did not reach a real adapter.
 *
 * Writes `before.png`, `after.png` and `parity.json` beside this file.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCENE = path.resolve(HERE, '..')
const ROOT = path.resolve(HERE, '../../../../..')
const CHROME =
  process.env.PARITY_CHROME ??
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')

const PAINT = 'packages/web/src/scene/paint.ts'

/** The last commit that still had the 2D painter. See the header. */
function lastWithPainter() {
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (git(['cat-file', '-e', `HEAD:${PAINT}`]).status === 0) return 'HEAD'
  const deleted = git(['log', '--format=%H', '--diff-filter=D', '-1', '--', PAINT]).stdout.trim()
  if (deleted === '') throw new Error(`${PAINT} is not in this history at all`)
  // Resolved to a concrete sha rather than left as `<deleted>^`, because the
  // commit that deleted the file is *this branch's own* and its sha changes on
  // every amend and rebase. What goes in `parity.json` has to still name the
  // baseline a year from now.
  return git(['rev-parse', `${deleted}^`]).stdout.trim()
}

const refAt = process.argv.indexOf('--ref')
const REF = refAt === -1 ? lastWithPainter() : (process.argv[refAt + 1] ?? 'HEAD')

/**
 * The 2D painter, out of history and into a scratch file.
 *
 * Its own imports are relative to `scene/`, so they are rewritten to absolute
 * paths back into the tree — the model layer both arms consume is the *same*
 * model layer, which is what makes this a painter comparison rather than two
 * different pictures.
 */
function legacyPainter(work) {
  const shown = spawnSync('git', ['show', `${REF}:${PAINT}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  if (shown.status !== 0) {
    throw new Error(`no canvas painter at ${REF}: ${shown.stderr.trim()}`)
  }
  const source = shown.stdout.replaceAll("from './", `from '${SCENE}/`)
  const file = path.join(work, 'legacy-paint.ts')
  fs.writeFileSync(file, source)
  return file
}

function entry(work, legacy) {
  const source = `
import { seededMarks, PANEL } from '${SCENE}/parity/scene.js'
import { paint } from '${legacy.replace(/\.ts$/, '.js')}'
import { createScenePainter } from '${SCENE}/gl/index.js'

const DPR = 2
const marks = seededMarks()

/** A canvas at the panel's size, in device pixels. */
function surface(id) {
  const canvas = document.createElement('canvas')
  canvas.id = id
  canvas.width = PANEL.width * DPR
  canvas.height = PANEL.height * DPR
  canvas.style.width = PANEL.width + 'px'
  canvas.style.height = PANEL.height + 'px'
  document.body.append(canvas)
  return canvas
}

function before() {
  const canvas = surface('before')
  const ctx = canvas.getContext('2d')
  paint({ ctx, marks, width: PANEL.width, height: PANEL.height, dpr: DPR })
  return canvas
}

function after() {
  const gl = surface('gl')
  const overlay = surface('overlay')
  const painter = createScenePainter(gl, overlay, { capture: true })
  painter.paint({ marks, width: PANEL.width, height: PANEL.height, dpr: DPR })

  // The two surfaces the browser composites, composited here instead, so the
  // capture is what a viewer actually sees rather than half of it.
  const flat = surface('after')
  const ctx = flat.getContext('2d')
  ctx.drawImage(gl, 0, 0)
  ctx.drawImage(overlay, 0, 0)
  return { flat, info: adapter() }
}

function adapter() {
  const probe = document.createElement('canvas').getContext('webgl2')
  if (probe === null) return { renderer: 'none', vendor: 'none' }
  const dbg = probe.getExtension('WEBGL_debug_renderer_info')
  const live = document.getElementById('gl').getContext('webgl2')
  return {
    renderer: dbg === null ? probe.getParameter(probe.RENDERER) : probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
    vendor: dbg === null ? probe.getParameter(probe.VENDOR) : probe.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
    // The painter's even-odd pass is a stencil pass; a context that quietly
    // handed back no stencil buffer would paint every contour's bounding box.
    stencilBits: live.getParameter(live.STENCIL_BITS),
    attributes: live.getContextAttributes(),
  }
}

/** Where the two pictures disagree, as numbers rather than as an impression. */
function difference(a, b) {
  const size = a.canvas.width * a.canvas.height
  let total = 0
  let over8 = 0
  let over32 = 0
  let worst = 0
  for (let i = 0; i < size; i += 1) {
    const at = i * 4
    const delta = Math.max(
      Math.abs(a.data[at] - b.data[at]),
      Math.abs(a.data[at + 1] - b.data[at + 1]),
      Math.abs(a.data[at + 2] - b.data[at + 2]),
    )
    total += delta
    if (delta > 8) over8 += 1
    if (delta > 32) over32 += 1
    if (delta > worst) worst = delta
  }
  return {
    pixels: size,
    meanDelta: +(total / size).toFixed(3),
    over8: +((over8 / size) * 100).toFixed(2),
    over32: +((over32 / size) * 100).toFixed(2),
    worst,
  }
}

/**
 * The committed evidence, at CSS size rather than device size.
 *
 * Every number above is computed at dpr 2 over the full 2200x1240 buffer; only
 * the PNG is halved. Three device-resolution captures of a noisy scene are 11 MB
 * of binary in a repository that has to carry them for ever, and a reader
 * comparing two pictures does not need the extra sample — the numbers are the
 * measurement, the pictures are the check that the numbers describe a scene.
 */
function shrink(canvas) {
  const small = document.createElement('canvas')
  small.width = PANEL.width
  small.height = PANEL.height
  const ctx = small.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, small.width, small.height)
  return small.toDataURL('image/png')
}

function read(canvas) {
  const ctx = canvas.getContext('2d')
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data: data.data, canvas }
}

/**
 * Where they differ, as a picture. Amplified 8x, because a delta anyone could
 * see unamplified would be a delta this migration got wrong.
 */
function differenceImage(a, b) {
  const canvas = surface('diff')
  const ctx = canvas.getContext('2d')
  const out = ctx.createImageData(canvas.width, canvas.height)
  for (let i = 0; i < canvas.width * canvas.height; i += 1) {
    const at = i * 4
    for (let c = 0; c < 3; c += 1) {
      out.data[at + c] = Math.min(255, Math.abs(a.data[at + c] - b.data[at + c]) * 8)
    }
    out.data[at + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  return canvas
}

/**
 * WHAT THE FRAME COSTS, on this box, on this adapter — reported, never asserted.
 *
 * Not the spike's measurement and not a replacement for it: this draws one
 * colony, so it is nowhere near the 30x3 workload ADR-0021 was decided on. It is
 * here because the suite can only time the *build* half (jsdom has no GPU), and a
 * number for the whole painter on real hardware is worth having beside it.
 *
 * **The two columns are not comparable, and that is stated rather than hidden.**
 * Both are JS time inside the painter call. The GL arm's column is very nearly
 * the whole cost — it builds every triangle on the CPU and submits two dozen draw
 * calls, and the GPU work behind them is small enough that a fence at the end of
 * the run barely moves the number. The canvas arm's column is **submission
 * only**: a canvas fill returns before anything is rasterised, and the
 * rasterisation is exactly what ADR-0021 measured at 40.2 ms and 127.8 ms. A
 * canvas number that included it needs a sync, a canvas sync is a ~150 ms
 * getImageData readback that also demotes the canvas to software raster, and that
 * is the asymmetry research/2026-08-15-renderer-spike.md exists to navigate.
 * **Read the spike for the decision; read this for the picture.**
 */
function timed(draw, frames) {
  const samples = []
  for (let i = 0; i < 10; i += 1) draw()
  const started = performance.now()
  for (let i = 0; i < frames; i += 1) {
    const at = performance.now()
    draw()
    samples.push(performance.now() - at)
  }
  const wall = performance.now() - started
  samples.sort((a, b) => a - b)
  return {
    cpuMs: +samples[Math.floor(samples.length / 2)].toFixed(3),
    wallMs: +(wall / frames).toFixed(3),
  }
}

function timings(canvasArm, glCanvas, overlayCanvas) {
  const ctx = canvasArm.getContext('2d')
  const canvas = timed(
    () => paint({ ctx, marks, width: PANEL.width, height: PANEL.height, dpr: DPR }),
    120,
  )

  const painter = createScenePainter(glCanvas, overlayCanvas, { capture: true })
  const gl = glCanvas.getContext('webgl2')
  const webgl = timed(
    () => painter.paint({ marks, width: PANEL.width, height: PANEL.height, dpr: DPR }),
    120,
  )
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
  if (fence !== null) {
    gl.clientWaitSync(fence, gl.SYNC_FLUSH_COMMANDS_BIT, 1e9)
    gl.deleteSync(fence)
  }
  return { canvas, webgl, frames: 120 }
}

async function run() {
  const canvasArm = before()
  const glArm = after()
  const canvasPixels = read(canvasArm)
  const glPixels = read(glArm.flat)
  const stats = difference(canvasPixels, glPixels)
  const diff = differenceImage(canvasPixels, glPixels)
  const cost = timings(canvasArm, document.getElementById('gl'), document.getElementById('overlay'))
  await fetch('/result', {
    method: 'POST',
    body: JSON.stringify({
      marks: marks.length,
      panel: PANEL,
      dpr: DPR,
      info: glArm.info,
      stats,
      cost,
      before: shrink(canvasArm),
      after: shrink(glArm.flat),
      diff: shrink(diff),
    }),
  })
}

run().catch((error) =>
  fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error), stack: error.stack }) }),
)
`
  const file = path.join(work, 'entry.ts')
  fs.writeFileSync(file, source)
  return file
}

function bundle(source, out) {
  const result = spawnSync(
    'npx',
    ['esbuild', source, '--bundle', '--format=esm', '--target=es2022', `--outfile=${out}`],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function serve(work) {
  let onResult = () => {}
  const server = http.createServer((request, response) => {
    if (request.url === '/result') {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        response.end('ok')
        onResult(JSON.parse(body))
      })
      return
    }
    if (request.url === '/bundle.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(fs.readFileSync(path.join(work, 'bundle.js')))
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><meta charset="utf8"><body style="margin:0;background:#000"><script type="module" src="/bundle.js"></script>')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => server.close(),
        next: () => new Promise((r) => (onResult = r)),
      }),
    )
  })
}

function launch(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-chrome-'))
  const child = spawn(
    CHROME,
    [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      `--user-data-dir=${profile}`,
      '--window-size=1200,700',
      `http://127.0.0.1:${port}/`,
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        GALLIUM_DRIVER: 'd3d12',
        LD_LIBRARY_PATH: '/usr/lib/wsl/lib',
      },
    },
  )
  return {
    child,
    cleanup: () => {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (error) {
        console.error(`(left ${profile} behind: ${error.code})`)
      }
    },
  }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-build-'))
  let server
  try {
    const legacy = legacyPainter(work)
    bundle(entry(work, legacy), path.join(work, 'bundle.js'))
    server = await serve(work)

    const { child, cleanup } = launch(server.port)
    const result = await Promise.race([
      server.next(),
      new Promise((_unused, reject) => setTimeout(() => reject(new Error('capture timed out')), 120_000)),
    ]).finally(() => {
      child.kill('SIGKILL')
      cleanup()
    })

    if (result.error !== undefined) throw new Error(`${result.error}\n${result.stack}`)
    if (/swiftshader|llvmpipe|software/i.test(String(result.info?.renderer ?? ''))) {
      throw new Error(`software rasteriser (${result.info.renderer}) — the capture is void`)
    }

    for (const [name, data] of [
      ['before', result.before],
      ['after', result.after],
      ['diff', result.diff],
    ]) {
      const file = path.join(HERE, `${name}.png`)
      fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'))
      console.error(`wrote ${file}`)
    }

    const summary = {
      ref: REF,
      marks: result.marks,
      panel: result.panel,
      dpr: result.dpr,
      adapter: result.info,
      difference: result.stats,
      cost: result.cost,
    }
    fs.writeFileSync(path.join(HERE, 'parity.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.error(JSON.stringify(summary, null, 2))
  } finally {
    server?.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
