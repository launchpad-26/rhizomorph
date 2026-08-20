#!/usr/bin/env node
/**
 * THE VISIT HARNESS — drive the real desktop shell, look at a surface, prove it.
 *
 * ADR-0026. Playwright's `_electron` launches `packages/app/dist/main.js` — the
 * shell itself, not the SPA in a borrowed browser — because the tray, the GPU
 * path, first-run and the window chrome are all product surface, and a harness
 * that skips them certifies a product nobody ships. Three seams make that safe
 * on this box, and each is load-bearing:
 *
 *  - `RHIZOMORPH_GPU_ENV_APPLIED=1` + the WSLg GPU env: the shell's own
 *    self-re-exec (entry.ts, the zygote fix) would detach the driver from the
 *    child; pre-applying the env means the relaunch never fires and Playwright
 *    keeps the process it launched.
 *  - `XDG_CONFIG_HOME` into a scratch dir: Electron derives userData from it on
 *    Linux, so a visit never reads or writes the operator's own prefs, and
 *    `--first-run` is genuinely a first run every time.
 *  - Headful. Headless Chromium on this machine falls back to SwiftShader,
 *    which the scene refuses by law — a headless visit would certify the
 *    canvas-floor error state instead of the picture.
 *
 * Usage:
 *   node scripts/dev/visit.mjs [route] [flags]
 *     --shot <path.png>     screenshot after settle (repeatable via --script)
 *     --theme dark|light    set data-theme before the shot
 *     --fixture 2|3         press the fixture key (20-lane / pathology)
 *     --repo <path>         RHIZOMORPH_REPO (omit = true first-run)
 *     --size WxH            window size (default the shell's own)
 *     --script <file.mjs>   default-export async ({ app, window, shot }) => {}
 *     --keep                leave the app running (default: close)
 *
 * Console messages and page errors are collected and printed; a page error
 * makes the exit code 1 so a loop cannot mistake a broken surface for a quiet
 * one.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron } from 'playwright'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : (args[i + 1] ?? null)
}
const has = (name) => args.includes(`--${name}`)
const route = args[0] && !args[0].startsWith('--') ? args[0] : '/'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '../..')
const MAIN = path.join(ROOT, 'packages/app/dist/main.js')

const scratchConfig = mkdtempSync(path.join(tmpdir(), 'rhizo-visit-'))

const env = {
  ...process.env,
  GALLIUM_DRIVER: process.env.GALLIUM_DRIVER ?? 'd3d12',
  LD_LIBRARY_PATH: `/usr/lib/wsl/lib${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`,
  RHIZOMORPH_GPU_ENV_APPLIED: '1',
  XDG_CONFIG_HOME: scratchConfig,
}
const repo = flag('repo')
if (repo === null) delete env.RHIZOMORPH_REPO
else env.RHIZOMORPH_REPO = repo

const app = await _electron.launch({ args: [MAIN], env, cwd: ROOT })
const window = await app.firstWindow()

const consoleLines = []
let pageErrors = 0
window.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`))
window.on('pageerror', (err) => {
  pageErrors += 1
  consoleLines.push(`[pageerror] ${err.message}`)
})

await window.waitForLoadState('domcontentloaded')
// The SPA boots, the server answers, the first frame settles.
await window.waitForTimeout(2500)

const size = flag('size')
if (size) {
  const [w, h] = size.split('x').map(Number)
  await app.evaluate(({ BrowserWindow }, dims) => {
    BrowserWindow.getAllWindows()[0]?.setSize(dims.w, dims.h)
  }, { w, h })
  await window.waitForTimeout(300)
}

if (route !== '/') {
  const base = new URL(window.url()).origin
  await window.goto(base + route)
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(1200)
}

const fixture = flag('fixture')
if (fixture) {
  await window.keyboard.press(fixture)
  await window.waitForTimeout(1500)
}

const theme = flag('theme')
if (theme) {
  // Written as the STORED PREFERENCE, not the attribute: settings/apply.ts
  // re-applies the stored choice on every preference/system change, so a bare
  // attribute write loses the moment anything else touches preferences
  // (loop 20 found captures silently reverting to follow-system).
  await window.evaluate((t) => {
    const KEY = 'rhizomorph.prefs.machine.v1'
    const bucket = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    bucket['appearance.theme'] = t
    localStorage.setItem(KEY, JSON.stringify(bucket))
    document.documentElement.dataset.theme = t
  }, theme)
  await window.waitForTimeout(600)
}

const shot = async (to) => {
  await window.screenshot({ path: to })
  console.log('shot:', to)
}

const shotPath = flag('shot')
if (shotPath) await shot(shotPath)

const scriptPath = flag('script')
if (scriptPath) {
  const mod = await import(pathToFileURL(path.resolve(scriptPath)).href)
  await mod.default({ app, window, shot })
}

if (consoleLines.length > 0) {
  console.log('--- console ---')
  for (const line of consoleLines) console.log(line)
}

if (!has('keep')) await app.close()
process.exit(pageErrors > 0 ? 1 : 0)
