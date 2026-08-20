import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The packaged app ships OUR icon, and the icon is exactly what its generator
 * produces.
 *
 * Until `build/icon.png` existed, every installer carried Electron's own atom —
 * the single most visible way a packaged app announces it is unfinished, and
 * something no unit test could ever have noticed. `electron-builder` derives
 * `.ico`, `.icns` and the Linux hicolor set from this one file, so its presence
 * and its shape are the whole requirement.
 *
 * ## Why regenerate rather than snapshot a hash
 *
 * A checked-in hash proves the bytes did not change. It does not prove the
 * bytes are still what the script draws — someone could hand-edit the PNG in an
 * image editor, update the hash, and the "generated" asset would quietly become
 * a hand-drawn one whose source lies about it. Re-running the generator and
 * comparing output is the stronger claim: the committed file IS the script's
 * output, or the build fails.
 *
 * That only works because the generator is deterministic, which it is on
 * purpose — every irregular-looking offset in it is a fixed function of a loop
 * index, and the deflate level is pinned because the zlib default varies
 * between builds.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.join(HERE, '..', '..')
const SCRIPT = path.join(APP, 'scripts', 'make-icon.mjs')
const ICON = path.join(APP, 'build', 'icon.png')

/** electron-builder's `buildResources` in `electron-builder.yml`. If this moves, the icon silently stops being found. */
const BUILD_RESOURCES_DIR = 'build'

function committed(): Buffer {
  return readFileSync(ICON)
}

describe('icon law: the packaged app ships our own icon, and it matches its generator', () => {
  it('the icon exists where electron-builder looks for it', () => {
    expect(path.basename(path.dirname(ICON))).toBe(BUILD_RESOURCES_DIR)
    expect(() => committed()).not.toThrow()
    expect(committed().length).toBeGreaterThan(10_000)
  })

  it('is a real 1024x1024 8-bit RGBA PNG — the size electron-builder needs to derive every platform', () => {
    const b = committed()
    expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(b.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(b.readUInt32BE(16)).toBe(1024)
    expect(b.readUInt32BE(20)).toBe(1024)
    expect(b[24]).toBe(8) // bit depth
    // Colour type 6 is RGBA. An alpha channel is not decoration here: the tile
    // has rounded corners, and without transparency they would be black
    // squares on every light background.
    expect(b[25]).toBe(6)
  })

  it('is byte-identical to what the generator produces right now — the asset cannot drift from its source', () => {
    const regenerated = execFileSync(process.execPath, [SCRIPT, '--stdout'], { maxBuffer: 64 * 1024 * 1024 })
    // Compared as bytes, not as a hash: on failure the lengths below say
    // whether the drawing changed or only the encoding did.
    expect(regenerated.length).toBe(committed().length)
    expect(regenerated.equals(committed())).toBe(true)
  })

  it('the generator is deterministic — two runs agree, so the check above is meaningful', () => {
    const a = execFileSync(process.execPath, [SCRIPT, '--stdout'], { maxBuffer: 64 * 1024 * 1024 })
    const b = execFileSync(process.execPath, [SCRIPT, '--stdout'], { maxBuffer: 64 * 1024 * 1024 })
    expect(a.equals(b)).toBe(true)
  })

  it("uses the instrument's own accent, so the icon and the thing it launches are the same picture", () => {
    // `TISSUE_400` — `#8441eb`, hue 295.5, which law 9a pins. Asserted against
    // the generator's source text rather than by decoding pixels: the point is
    // that the drawing is specified in terms of the palette, and a decoded
    // centre pixel would also pass if someone had typed a lookalike hex.
    const source = readFileSync(SCRIPT, 'utf8')
    expect(source).toContain('const ACCENT = [132, 65, 235]')
    expect(source).toContain('#8441eb')
    // The light direction the whole scene uses. Same reason: continuity is the
    // claim, so the constant is the thing to check.
    expect(source).toContain('const LIGHT = { x: -0.44, y: -0.9 }')
  })
})
