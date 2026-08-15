/**
 * THE RUNNER — bundles the spike, serves it, drives Chromium, collects JSON.
 *
 * Chromium must run **headful**. This is not a preference: headless Chrome on
 * this box falls back to SwiftShader (software rasterisation, confirmed by
 * `UNMASKED_RENDERER_WEBGL`), which would have measured a CPU rasteriser in both
 * arms and called it a GPU comparison. Under WSLg with `GALLIUM_DRIVER=d3d12`
 * the headful browser reaches the real adapter, and the runner asserts as much
 * before believing a single number — see `assertRealGpu`.
 *
 *   node research/spikes/renderer/run.mjs            # the full matrix, 3 runs
 *   node research/spikes/renderer/run.mjs --quick    # one 3s run per cell
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const CHROME =
  process.env.SPIKE_CHROME ??
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')

const QUICK = process.argv.includes('--quick')
const SHOTS = process.argv.includes('--shots')
/** The bounding diagnostic for the "bake the mass offscreen" objection. */
const SHELLS = process.argv.includes('--shells')
const SECONDS = QUICK ? 3 : 30
const RUNS = QUICK ? 1 : 3

/**
 * WHICH GPU. Under WSLg the d3d12 gallium driver picks the *integrated* adapter
 * unless told otherwise, so this box offers both halves of the brief's "this
 * machine and, if you can find one, a weaker configuration" without needing a
 * second machine: the discrete RTX 4070 and the Intel Iris Xe iGPU that sits
 * beside it. Both are measured; neither is presented as the only answer.
 */
const ADAPTERS = {
  discrete: { MESA_D3D12_DEFAULT_ADAPTER_NAME: 'NVIDIA' },
  integrated: { MESA_D3D12_DEFAULT_ADAPTER_NAME: 'Intel' },
}

const MATRIX = []
for (const adapter of ['discrete', 'integrated']) {
  for (const lanes of [30, 60]) {
    for (const renderer of ['canvas', 'webgl']) {
      MATRIX.push({ adapter, renderer, lanes, colonies: 3, dpr: 2 })
    }
  }
  // The single-colony control, so the cost of the multi-person case is separable.
  for (const renderer of ['canvas', 'webgl']) {
    MATRIX.push({ adapter, renderer, lanes: 30, colonies: 1, dpr: 2 })
  }
  // The fill-rate axis: same content, a quarter of the device pixels.
  for (const renderer of ['canvas', 'webgl']) {
    MATRIX.push({ adapter, renderer, lanes: 30, colonies: 3, dpr: 1 })
  }
  // ADR-0006's own workload: today's flat display list, no prd-33 material. The
  // cell that says whether the workload — rather than the hardware or the year —
  // is what moved.
  for (const renderer of ['canvas', 'webgl']) {
    MATRIX.push({ adapter, renderer, lanes: 30, colonies: 3, dpr: 2, material: 'flat' })
  }
  // Canvas without the film grain, which is the one mark the WebGL arm skips.
  // Bounds the error that asymmetry puts in the headline.
  MATRIX.push({ adapter, renderer: 'canvas', lanes: 30, colonies: 3, dpr: 2, noGrain: 1 })
  // The masses' iso-shells deleted, both arms — the floor an offscreen mass
  // cache could ever reach. See `noShells` in scene.ts for why this cell exists.
  for (const renderer of ['canvas', 'webgl']) {
    MATRIX.push({ adapter, renderer, lanes: 30, colonies: 3, dpr: 2, noShells: 1 })
  }
}

/** `--shells`: the same cell with the masses' iso-shells deleted, both arms. */
const SHELL_MATRIX = []
for (const adapter of ['discrete', 'integrated']) {
  for (const renderer of ['canvas', 'webgl']) {
    SHELL_MATRIX.push({ adapter, renderer, lanes: 30, colonies: 3, dpr: 2, noShells: 1 })
  }
}

function bundle() {
  const out = path.join(HERE, 'bench.js')
  const result = spawnSync(
    'npx',
    [
      'esbuild',
      path.join(HERE, 'bench.ts'),
      '--bundle',
      '--format=esm',
      '--target=es2022',
      '--minify',
      `--outfile=${out}`,
      '--metafile=' + path.join(HERE, 'bench.meta.json'),
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout)
    throw new Error('bundle failed')
  }
  return out
}

/**
 * BUNDLE COST, both arms, measured the way the deliverable asks: what does each
 * painter add over the display list that both share? Built by bundling three
 * entry points and differencing them, minified, and again gzipped.
 */
function bundleCost() {
  const entries = {
    model: `import {makeWorld} from './scene.js'; console.log(makeWorld)`,
    canvas: `import {makeWorld} from './scene.js'; import {paint} from '../../../packages/web/src/scene/paint.js'; console.log(makeWorld, paint)`,
    webgl: `import {makeWorld} from './scene.js'; import {createGlPainter} from './webgl.js'; console.log(makeWorld, createGlPainter)`,
  }
  const sizes = {}
  for (const [name, source] of Object.entries(entries)) {
    const entry = path.join(HERE, `.size-${name}.ts`)
    const out = path.join(HERE, `.size-${name}.js`)
    fs.writeFileSync(entry, source)
    const r = spawnSync(
      'npx',
      ['esbuild', entry, '--bundle', '--format=esm', '--target=es2022', '--minify', `--outfile=${out}`],
      { cwd: ROOT, encoding: 'utf8' },
    )
    if (r.status !== 0) throw new Error(`size bundle ${name}: ${r.stderr}`)
    const raw = fs.readFileSync(out)
    const gz = spawnSync('gzip', ['-9', '-c'], { input: raw, maxBuffer: 1 << 28 })
    sizes[name] = { minified: raw.length, gzipped: gz.stdout.length }
    fs.unlinkSync(entry)
    fs.unlinkSync(out)
  }
  return sizes
}

function serve(port0 = 0) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }
  let onResult = () => {}
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/result') {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        res.end('ok')
        onResult(JSON.parse(body))
      })
      return
    }
    const file = url.pathname === '/' ? '/index.html' : url.pathname
    const abs = path.join(HERE, file)
    if (!abs.startsWith(HERE) || !fs.existsSync(abs)) {
      res.statusCode = 404
      res.end('no')
      return
    }
    res.setHeader('content-type', types[path.extname(abs)] ?? 'application/octet-stream')
    res.end(fs.readFileSync(abs))
  })
  return new Promise((resolve) => {
    server.listen(port0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => server.close(),
        next: () => new Promise((r) => (onResult = r)),
      }),
    )
  })
}

function launch(port, query, adapter) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-chrome-'))
  const child = spawn(
    CHROME,
    [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      `--user-data-dir=${profile}`,
      '--window-size=1500,960',
      `http://127.0.0.1:${port}/?${query}`,
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        GALLIUM_DRIVER: 'd3d12',
        LD_LIBRARY_PATH: '/usr/lib/wsl/lib',
        ...(ADAPTERS[adapter] ?? {}),
      },
    },
  )
  // Chrome is still flushing its profile when SIGKILL lands, so a recursive
  // remove races it and throws ENOTEMPTY. It did, at cell 62 of 66, and took the
  // entire unwritten run with it. A scratch directory failing to delete is not a
  // reason to lose forty minutes of measurement.
  const cleanup = () => {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      console.error(`(left ${profile} behind: ${error.code})`)
    }
  }
  return { child, cleanup }
}

/**
 * A software rasteriser answers every question wrongly and looks like an answer.
 * If the WebGL arm did not reach a real adapter, the run is void.
 */
function assertRealGpu(result) {
  const renderer = String(result?.info?.renderer ?? '')
  if (result.config.renderer !== 'webgl') return
  if (/swiftshader|llvmpipe|software/i.test(renderer)) {
    throw new Error(`software rasteriser (${renderer}) — the run is void`)
  }
}

/**
 * One frame from each arm, as a PNG on disk. The verdict is not admissible
 * without them: a painter that draws nothing is the fastest painter there is.
 */
async function shots(server) {
  for (const renderer of ['canvas', 'webgl']) {
    const query = new URLSearchParams({
      renderer,
      lanes: 30,
      colonies: 3,
      dpr: 2,
      shot: 1,
    }).toString()
    const { child, cleanup } = launch(server.port, query, 'discrete')
    const result = await Promise.race([
      server.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('shot timeout')), 90_000)),
    ]).finally(() => {
      child.kill('SIGKILL')
      cleanup()
    })
    if (result.error !== undefined) throw new Error(`${renderer} shot: ${result.error}\n${result.stack}`)
    const file = path.join(HERE, `shot-${renderer}.png`)
    fs.writeFileSync(file, Buffer.from(result.png.split(',')[1], 'base64'))
    console.error(`wrote ${file}`)
  }
}

async function main() {
  bundle()
  const server = await serve()

  if (SHOTS) {
    await shots(server)
    server.close()
    return
  }

  const results = []
  const file = path.join(HERE, QUICK ? 'results-quick.json' : SHELLS ? 'results-shells.json' : 'results.json')
  // Measured up front, so a crash in the last cell cannot cost the bundle
  // numbers too — and flushed after every cell for the same reason.
  const meta = {
    hardware: {
      platform: process.platform,
      cpu: os.cpus()[0].model,
      cores: os.cpus().length,
      memGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
      release: os.release(),
    },
    bundle: bundleCost(),
    seconds: SECONDS,
    runs: RUNS,
  }
  const flush = () => fs.writeFileSync(file, JSON.stringify({ ...meta, results }, null, 2))
  flush()

  for (const cell of SHELLS ? SHELL_MATRIX : MATRIX) {
    for (let run = 1; run <= RUNS; run += 1) {
      const query = new URLSearchParams({ ...cell, seconds: SECONDS, run }).toString()
      const { child, cleanup } = launch(server.port, query, cell.adapter)
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), (SECONDS + 90) * 1000),
      )
      let result
      try {
        result = await Promise.race([server.next(), timeout])
      } finally {
        child.kill('SIGKILL')
        cleanup()
      }
      if (result.error !== undefined) throw new Error(`${query}: ${result.error}\n${result.stack}`)
      assertRealGpu(result)
      result.adapter = cell.adapter
      results.push(result)
      flush()
      console.error(
        `[${cell.adapter}] ${cell.renderer} lanes=${cell.lanes} col=${cell.colonies} dpr=${cell.dpr} run ${run}: ` +
          `frame ${result.streamFrameMs.toFixed(2)}ms ` +
          `p95 ${result.streamPerFrameMs.p95.toFixed(2)} ` +
          `(model ${result.modelMs.median.toFixed(2)} submit ${result.submitMs.median.toFixed(2)})`,
      )
    }
  }

  server.close()
  flush()
  console.error(`\nwrote ${file}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
