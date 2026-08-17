import { deflateSync } from 'node:zlib'
import type { LadderRank } from '@rhizomorph/core'

/**
 * THE TRAY ICON, DRAWN RATHER THAN SHIPPED (#564).
 *
 * A tray needs a bitmap and this repo has no binary assets. Both facts are
 * load-bearing rather than incidental: a committed `.png` per rung is five
 * files a reviewer cannot read, cannot diff, and cannot check against the
 * instrument's own palette — and the rung colours are exactly the kind of thing
 * that drifts silently once it lives somewhere nobody looks. Drawn here, the
 * icon is a function of the rung, its hues are constants a law test holds
 * against `theme.css`, and the encoder is small enough to test end to end.
 *
 * ## The alphabet is the instrument's own
 *
 * `sigils.tsx`' rule — **form says which, hue says how bad** — is why each rung
 * gets a shape rather than only a colour. A 16px tray icon is where colour is
 * least reliable: macOS renders template images monochrome, Linux tray themes
 * recolour, and Windows draws over whatever the taskbar happens to be. A person
 * who cannot see the hue still sees a ring, a dot, a triangle or a square.
 *
 * ## macOS gets the same shapes in black
 *
 * A template image must be black-and-alpha and the OS tints it; `main/tray.ts`
 * asks for {@link TEMPLATE_INK} there. The shape is identical, so the rung is
 * still legible when the hue is not ours to choose.
 */

export type IconShape = 'ring' | 'dot' | 'triangle' | 'square' | 'hollow-square'

/** The icon's size in pixels. 16 is the tray's native size on all three platforms; the OS scales up, never down. */
export const ICON_SIZE = 16

/**
 * The instrument's own rung hues, from `theme.css`'s dark palette:
 * `--color-needs-you`, `--color-broken`, `--color-notice`, and
 * `--color-ice-400` for a fleet at rest (structure, never a status).
 * `tray-icon.test.ts` reads all four out of that file.
 */
export const RANK_INK: Record<LadderRank, string> = {
  calm: '#6a81a8',
  notice: '#4deaff',
  'needs-you': '#ffc857',
  broken: '#ff3d68',
}

/** What a template image is drawn in: opaque black, tinted by macOS itself. */
export const TEMPLATE_INK = '#000000'

/** The shape each rung wears. Rising: nothing at rest, then a point, then a summons, then a slab. */
export const RANK_SHAPE: Record<LadderRank, IconShape> = {
  calm: 'ring',
  notice: 'dot',
  'needs-you': 'triangle',
  broken: 'square',
}

/**
 * A 16×16 RGBA raster, transparent except the mark. Exported for the test —
 * asserting on pixels is how "the triangle is actually a triangle" stays a
 * fact rather than a filename.
 */
export function iconPixels(shape: IconShape, ink: string): Uint8Array {
  const [r, g, b] = parseHex(ink)
  const pixels = new Uint8Array(ICON_SIZE * ICON_SIZE * 4)

  const set = (x: number, y: number, alpha: number): void => {
    if (x < 0 || y < 0 || x >= ICON_SIZE || y >= ICON_SIZE || alpha <= 0) return
    const at = (y * ICON_SIZE + x) * 4
    pixels[at] = r
    pixels[at + 1] = g
    pixels[at + 2] = b
    pixels[at + 3] = alpha
  }

  const centre = (ICON_SIZE - 1) / 2

  if (shape === 'ring' || shape === 'dot') {
    const outer = shape === 'ring' ? 6.5 : 3.5
    const inner = shape === 'ring' ? 4.5 : 0
    for (let y = 0; y < ICON_SIZE; y += 1) {
      for (let x = 0; x < ICON_SIZE; x += 1) {
        const distance = Math.hypot(x - centre, y - centre)
        if (distance <= outer && distance >= inner) set(x, y, 255)
      }
    }
    return pixels
  }

  if (shape === 'triangle') {
    // Apex up, base at the bottom — the summons, pointing at you.
    const top = 2
    const bottom = ICON_SIZE - 3
    for (let y = top; y <= bottom; y += 1) {
      const progress = (y - top) / (bottom - top)
      const halfWidth = progress * 7
      for (let x = Math.round(centre - halfWidth); x <= Math.round(centre + halfWidth); x += 1) set(x, y, 255)
    }
    return pixels
  }

  // Both squares, filled or outlined.
  const from = 3
  const to = ICON_SIZE - 4
  for (let y = from; y <= to; y += 1) {
    for (let x = from; x <= to; x += 1) {
      const onEdge = x === from || x === to || y === from || y === to
      if (shape === 'square' || onEdge) set(x, y, 255)
    }
  }
  return pixels
}

/** The icon as a `data:` URL — what `nativeImage.createFromDataURL` takes. */
export function iconDataUrl(shape: IconShape, ink: string): string {
  return `data:image/png;base64,${Buffer.from(encodePng(iconPixels(shape, ink))).toString('base64')}`
}

/**
 * A minimal PNG encoder: signature, IHDR, one IDAT of zlib-deflated scanlines
 * (filter byte 0), IEND. Sixty lines instead of a dependency, because the
 * alternative — `pngjs`, or `sharp` — is a package in the lockfile for one
 * 16×16 image the app draws four of.
 */
export function encodePng(rgba: Uint8Array, size: number = ICON_SIZE): Uint8Array {
  const raw = new Uint8Array((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1)
  }

  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, size)
  view.setUint32(4, size)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = Uint8Array.from([...type].map((character) => character.charCodeAt(0)))
  const body = concat([name, data])
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, data.length)
  const crc = new Uint8Array(4)
  new DataView(crc.buffer).setUint32(0, crc32(body))
  return concat([length, body, crc])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ]
}
