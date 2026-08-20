import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

/**
 * THE APP ICON, generated rather than drawn.
 *
 * `electron-builder` derives every platform's icon — `.ico`, `.icns` and the
 * Linux hicolor set — from one `build/icon.png`, so one file is the whole
 * requirement. Until this existed the installers shipped Electron's own atom,
 * which is the single most visible way a packaged app says "unfinished".
 *
 * It is a script rather than a hand-drawn asset for the reason everything else
 * here is derived: a binary nobody can diff is a binary nobody can check.
 * `icon-law.test.ts` re-runs this generator and compares the result
 * byte-for-byte with the committed PNG, so the asset cannot drift from its
 * source, and a hand-edit fails the build.
 *
 * ## The mark
 *
 * The instrument's own subject: a lit core with cords running out of it. It is
 * drawn with the scene's real constants, so the icon and the thing it launches
 * are the same picture —
 *
 *  - the accent is `TISSUE_400`, `#8441eb`, at hue 295.5 (`scene/palette.ts`;
 *    law 9a pins that hue). The centre is asserted to be exactly this.
 *  - the light comes from `LIGHT = { x: -0.44, y: -0.9 }`
 *    (`scene/marks/lighting.ts`), so the rim brightens up and to the left
 *    exactly as every mark in the running scene does.
 *  - the lamp only subtracts: the ground is dark, the core is the one source,
 *    and the cords are shaded DOWN from the accent rather than lit past it.
 *    That is the rule three laws taught the scene, obeyed here too.
 *
 * At 16px none of the cords survive; what survives is a bright core on a dark
 * tile, which is the silhouette this is composed for. The detail is for the
 * 512 and 1024 cases — installer, store listing, about box.
 */

const SIZE = 1024

/** `TISSUE_400` — THE accent, `#8441eb`, at hue 295.5 as the palette pins it. */
const ACCENT = [132, 65, 235]
/** A near-black with a violet bias, so the tile reads as chosen rather than defaulted. */
const GROUND = [11, 7, 16]
/** `scene/marks/lighting.ts` — the one light direction the whole instrument uses. */
const LIGHT = { x: -0.44, y: -0.9 }

const CORNER = 180 / 1024
/** The body's radius. Large on purpose: the first draft used 0.085 and read as a lens flare — a hard dot with rays — rather than a lit mass with tissue coming out of it. */
const CORE = 0.19
const GLOW = 0.52
const CORDS = 7
/**
 * How far each cord bends over its length, in radians per unit radius.
 *
 * Straight cords were the other half of why the first draft looked like a
 * starburst: dead-straight lines radiating from a point are what a light flare
 * does, and the subject here is mycelium. Bending the angle as a function of
 * radius costs nothing per pixel and turns rays into tendrils.
 */
const CURL = 0.62
/** `root.ts`'s `LEAN` — the body's lit core sits offset toward the light rather than centred. */
const LEAN = 0.24

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Coverage of a rounded rectangle filling the canvas, with a one-pixel soft edge so corners are not stair-stepped. */
function tileCoverage(nx, ny, radius) {
  const qx = Math.abs(nx) - (1 - radius)
  const qy = Math.abs(ny) - (1 - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
  return clamp(0.5 - outside * SIZE * 0.5, 0, 1)
}

/** How strongly a point sits on one of the cords running out of the body. */
function cordWeight(nx, ny) {
  const r = Math.hypot(nx, ny)
  if (r < CORE * 0.62 || r > 0.94) return 0
  const theta = Math.atan2(ny, nx)
  let best = 0
  for (let i = 0; i < CORDS; i += 1) {
    // Deliberately irregular: evenly spaced spokes read as a machine part and
    // the subject is tissue. Every offset is a fixed function of the index
    // rather than random, so the output is reproducible — the law depends on it.
    const base = (i / CORDS) * Math.PI * 2 + Math.sin(i * 2.399) * 0.22
    // The bend. Alternating sign so the cords do not all sweep the same way,
    // which would read as motion blur rather than growth.
    const curl = CURL * (i % 2 === 0 ? 1 : -0.72) * (0.7 + 0.3 * Math.sin(i * 1.7))
    const angle = base + curl * (r - CORE)
    const d = Math.abs(((theta - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI)

    // Each cord runs a different distance, so the silhouette is not a wheel.
    const reach = 0.62 + 0.3 * ((Math.sin(i * 3.1) + 1) / 2)
    if (r > reach) continue

    // Taper: thick where it leaves the body, thin at the tip. Angular width has
    // to grow as 1/r to hold a constant thickness in pixels, or a cord looks
    // like a wedge.
    const thickness = 0.052 * (1 - 0.72 * (r / reach))
    const width = thickness / Math.max(r, 0.08)
    const w = clamp(1 - d / width, 0, 1)

    // Fade in out of the body and out again before the tip, so nothing ends in
    // a hard cut.
    const fade = clamp((reach - r) / 0.26, 0, 1) * clamp((r - CORE * 0.62) / 0.12, 0, 1)
    best = Math.max(best, w * w * fade)
  }
  return best
}

/**
 * The body: a lit mass, not a dot.
 *
 * Concentric shells with the highlight offset toward the light, which is what
 * `root.ts` does with `LEAN` and `DEPTH.rindGain` — the thing that made the
 * real scene's centre read as having volume instead of being a flat disc.
 */
function bodyWeight(nx, ny) {
  const r = Math.hypot(nx, ny)
  if (r > CORE * 1.35) return { mass: 0, hot: 0 }
  // Soft-edged mass.
  const mass = clamp((CORE - r) / (CORE * 0.42) + 1, 0, 1)
  // The lit side, offset along the light direction.
  const hx = nx - LIGHT.x * CORE * LEAN
  const hy = ny - LIGHT.y * CORE * LEAN
  const hr = Math.hypot(hx, hy)
  const hot = Math.pow(clamp(1 - hr / (CORE * 0.82), 0, 1), 1.5)
  // Shell banding — faint, and it only ever subtracts.
  const shell = 1 - 0.14 * Math.pow(clamp(Math.sin(r / CORE * 7.5), 0, 1), 2)
  return { mass: mass * shell, hot }
}

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y += 1) {
    const ny = (y / (SIZE - 1)) * 2 - 1
    for (let x = 0; x < SIZE; x += 1) {
      const nx = (x / (SIZE - 1)) * 2 - 1
      const r = Math.hypot(nx, ny)
      let rgb = [...GROUND]

      // The tile's own edge catches the light, up and to the left.
      const edge = clamp(1 - Math.abs(Math.max(Math.abs(nx), Math.abs(ny)) - 1) * 26, 0, 1)
      const facing = clamp(-(nx * LIGHT.x + ny * LIGHT.y) / (r || 1), 0, 1)
      const rim = edge * facing * 0.5
      rgb = rgb.map((c, i) => c + (ACCENT[i] - c) * rim * 0.55)

      // The subsurface bloom around the body — low frequency, and the thing
      // that makes the mass read as lit rather than painted. The scene learned
      // this the hard way: shading each cord is texture, the glow is drama.
      const bloom = Math.pow(clamp(1 - r / GLOW, 0, 1), 2.4)
      rgb = rgb.map((c, i) => c + (ACCENT[i] * 0.55 - c) * bloom * 0.55)

      // The cords, shaded DOWN from the accent — never brighter than the body.
      const cord = cordWeight(nx, ny)
      rgb = rgb.map((c, i) => c + (ACCENT[i] * 0.78 - c) * cord * 0.82)

      // The body last, so nothing overdraws it. One light source.
      const { mass, hot } = bodyWeight(nx, ny)
      rgb = rgb.map((c, i) => c + (ACCENT[i] * 0.62 - c) * mass)
      rgb = rgb.map((c, i) => c + (Math.min(255, ACCENT[i] + 74) - c) * hot * mass)

      const o = (y * SIZE + x) * 4
      px[o] = Math.round(clamp(rgb[0], 0, 255))
      px[o + 1] = Math.round(clamp(rgb[1], 0, 255))
      px[o + 2] = Math.round(clamp(rgb[2], 0, 255))
      px[o + 3] = Math.round(tileCoverage(nx, ny, CORNER) * 255)
    }
  }
  return px
}

// ── PNG encoding, by hand ───────────────────────────────────────────────────
// No `sharp` and no ImageMagick: neither is installed on this machine, and
// adding a native image dependency to ship one static file would be a poor
// trade. A PNG is a signature, three chunks and a CRC.

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // bytes 10-12 stay zero: deflate, adaptive filtering, no interlace.

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0 // filter type 0 — none. Simple and reproducible.
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Level 9 explicitly: the default varies between zlib builds, and the law
    // compares bytes.
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The icon as bytes. Exported so the law can regenerate it without writing a file. */
export function buildIcon() {
  return encodePng(render(), SIZE)
}

export const ICON_SIZE = SIZE
export const ICON_ACCENT = ACCENT

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (invokedDirectly) {
  const png = buildIcon()
  // `--stdout` exists for `icon-law.test.ts`, which regenerates the icon and
  // compares it with the committed file. Going through the real script rather
  // than importing this module means the law covers the CLI path a person
  // actually runs, and keeps a `.mjs` out of the TypeScript module graph.
  if (process.argv.includes('--stdout')) {
    process.stdout.write(png)
  } else {
    const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
    writeFileSync(out, png)
    console.log(`wrote ${out} — ${SIZE}x${SIZE}, ${png.length} bytes`)
  }
}
