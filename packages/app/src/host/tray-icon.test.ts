import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { LADDER_ORDER } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { encodePng, iconDataUrl, iconPixels, ICON_SIZE, RANK_INK, RANK_SHAPE } from './tray-icon.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** The alpha channel as a 16×16 grid of booleans — what the eye actually sees. */
function inked(shape: Parameters<typeof iconPixels>[0]): boolean[][] {
  const pixels = iconPixels(shape, '#ffffff')
  const rows: boolean[][] = []
  for (let y = 0; y < ICON_SIZE; y += 1) {
    const row: boolean[] = []
    for (let x = 0; x < ICON_SIZE; x += 1) row.push((pixels[(y * ICON_SIZE + x) * 4 + 3] ?? 0) > 0)
    rows.push(row)
  }
  return rows
}

const litCount = (rows: boolean[][]) => rows.flat().filter(Boolean).length

describe('the shapes are the shapes they claim to be', () => {
  it('draws a ring: lit at the edge of the circle, hollow at the centre', () => {
    const rows = inked('ring')
    // The middle row: dark at the centre, lit where the band crosses it, dark
    // again outside the circle. Three points, so this cannot pass on a blob.
    expect(rows[7]?.[7]).toBe(false)
    expect(rows[7]?.[2]).toBe(true)
    expect(rows[7]?.[0]).toBe(false)
    expect(litCount(rows)).toBeGreaterThan(20)
  })

  it('draws a dot: lit at the centre, dark at the corners', () => {
    const rows = inked('dot')
    expect(rows[8]?.[8]).toBe(true)
    expect(rows[0]?.[0]).toBe(false)
    expect(litCount(rows)).toBeLessThan(litCount(inked('square')))
  })

  it('draws a triangle: narrow at the top, wide at the bottom', () => {
    const rows = inked('triangle')
    const widthAt = (y: number) => rows[y]?.filter(Boolean).length ?? 0
    expect(widthAt(3)).toBeGreaterThan(0)
    expect(widthAt(12)).toBeGreaterThan(widthAt(3))
    // …and it is a triangle rather than a wedge: the widest row is the last one.
    expect(widthAt(13)).toBeGreaterThanOrEqual(widthAt(12))
  })

  it('draws a filled square and a hollow one that differ where it matters', () => {
    const filled = inked('square')
    const hollow = inked('hollow-square')
    expect(filled[8]?.[8]).toBe(true)
    expect(hollow[8]?.[8]).toBe(false)
    expect(filled[3]?.[3]).toBe(true)
    expect(hollow[3]?.[3]).toBe(true)
  })

  it('leaves everything else transparent — a tray icon is not a tile', () => {
    for (const shape of ['ring', 'dot', 'triangle', 'square', 'hollow-square'] as const) {
      expect(litCount(inked(shape))).toBeLessThan(ICON_SIZE * ICON_SIZE)
    }
  })

  it('gives each rung a different form', () => {
    const shapes = LADDER_ORDER.map((rank) => RANK_SHAPE[rank])
    expect(new Set(shapes).size).toBe(LADDER_ORDER.length)
  })
})

describe('the ink is the instrument\'s own, read from the theme (#564)', () => {
  const theme = readFileSync(path.join(REPO_ROOT, 'packages', 'web', 'src', 'theme', 'theme.css'), 'utf8')
  // The dark palette is declared first; the light theme redeclares the same
  // names further down, so each lookup takes the FIRST match deliberately.
  const hexOf = (token: string) => new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})`).exec(theme)?.[1]?.toLowerCase()

  it('found the theme to read', () => {
    expect(theme.length).toBeGreaterThan(1000)
    expect(hexOf('needs-you')).toMatch(/^#[0-9a-f]{6}$/)
  })

  it.each([
    ['needs-you', 'needs-you'],
    ['broken', 'broken'],
    ['notice', 'notice'],
  ] as const)('takes %s from the theme rather than inventing one', (rank, token) => {
    expect(RANK_INK[rank].toLowerCase()).toBe(hexOf(token))
  })

  it('draws a fleet at rest in structure ink, never a status hue', () => {
    expect(RANK_INK.calm.toLowerCase()).toBe(hexOf('ice-400'))
  })
})

describe('the PNG encoder', () => {
  const png = encodePng(iconPixels('square', '#ff3d68'))

  it('writes a real PNG signature', () => {
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('declares the size and colour type it actually wrote', () => {
    const view = new DataView(png.buffer, png.byteOffset)
    // IHDR data begins at byte 16: 8 signature + 4 length + 4 type.
    expect(view.getUint32(16)).toBe(ICON_SIZE)
    expect(view.getUint32(20)).toBe(ICON_SIZE)
    expect(png[24]).toBe(8) // bit depth
    expect(png[25]).toBe(6) // RGBA
  })

  it('round-trips: the pixels inflate back to what was encoded', () => {
    const start = png.indexOf(0x49, 33) // "IDAT" begins shortly after IHDR's CRC
    const idatType = png.slice(start, start + 4)
    expect(String.fromCharCode(...idatType)).toBe('IDAT')
    const length = new DataView(png.buffer, png.byteOffset).getUint32(start - 4)
    const raw = new Uint8Array(inflateSync(png.slice(start + 4, start + 4 + length)))

    // One filter byte per scanline, then the row's RGBA.
    expect(raw.length).toBe((ICON_SIZE * 4 + 1) * ICON_SIZE)
    const source = iconPixels('square', '#ff3d68')
    expect(raw[0]).toBe(0)
    expect([...raw.slice(1, 1 + ICON_SIZE * 4)]).toEqual([...source.slice(0, ICON_SIZE * 4)])
  })

  it('ends with IEND', () => {
    expect(String.fromCharCode(...png.slice(-8, -4))).toBe('IEND')
  })

  it('produces a different image per rung — one icon for four rungs would be the bug', () => {
    const urls = LADDER_ORDER.map((rank) => iconDataUrl(RANK_SHAPE[rank], RANK_INK[rank]))
    expect(new Set(urls).size).toBe(LADDER_ORDER.length)
    for (const url of urls) expect(url.startsWith('data:image/png;base64,')).toBe(true)
  })
})
