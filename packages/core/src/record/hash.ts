/**
 * A self-contained SHA-256 (FIPS 180-4), so the hash chain needs neither
 * `node:crypto` (Node-only) nor the Web Crypto API's `subtle.digest`, which
 * is async and would force `buildRecord`/`verifyRecord` to stop being plain
 * pure functions. Zero ambient assumptions — same rule as `state.ts`'s
 * `basename`, which runs in the browser too and stays dependency-free for
 * exactly this reason.
 */

const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

const INITIAL_HASH: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** Manual UTF-8 encoder — `TextEncoder` is a DOM/Node global this package doesn't assume. */
function utf8Encode(str: string): number[] {
  const bytes: number[] = []
  for (const char of str) {
    const cp = char.codePointAt(0) ?? 0
    if (cp < 0x80) {
      bytes.push(cp)
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    }
  }
  return bytes
}

/** FIPS 180-4 padding + 64-round compression, over already-UTF-8 bytes. */
function sha256Bytes(bytes: readonly number[]): number[] {
  const bitLen = bytes.length * 8
  const padded = bytes.slice()
  padded.push(0x80)
  while (padded.length % 64 !== 56) padded.push(0)
  // A 64-bit big-endian bit-length; `hi` is always 0 for any message this
  // package will ever hash (a session log under 2^32 bits — 512MB), but the
  // spec's full 64 bits are written anyway rather than assumed away.
  const hi = Math.floor(bitLen / 2 ** 32)
  const lo = bitLen >>> 0
  for (const word of [hi, lo]) {
    padded.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff)
  }

  let h0 = INITIAL_HASH[0]!
  let h1 = INITIAL_HASH[1]!
  let h2 = INITIAL_HASH[2]!
  let h3 = INITIAL_HASH[3]!
  let h4 = INITIAL_HASH[4]!
  let h5 = INITIAL_HASH[5]!
  let h6 = INITIAL_HASH[6]!
  let h7 = INITIAL_HASH[7]!

  const w = new Array<number>(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const i = offset + t * 4
      w[t] =
        ((padded[i]! << 24) | (padded[i + 1]! << 16) | (padded[i + 2]! << 8) | padded[i + 3]!) >>> 0
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3)
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10)
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + K[t]! + w[t]!) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
}

function toHex(words: readonly number[]): string {
  return words.map((word) => word.toString(16).padStart(8, '0')).join('')
}

/** SHA-256 of a UTF-8 string, as a 64-character lowercase hex digest. */
export function sha256Hex(input: string): string {
  return toHex(sha256Bytes(utf8Encode(input)))
}

/** What every hex digest in the record format must look like. */
export const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/
