import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearCookieHeader,
  deriveSessionKey,
  issueOauthStateCookie,
  parseCookieHeader,
  setCookieHeader,
  signSessionCookie,
  verifySessionCookie,
  verifyStateCookie,
} from './session.js'

/** Synthetic throughout — no real client secret ever appears in this file. */
const SECRET = 'the-client-secret'
const OTHER_SECRET = 'a-different-client-secret'
const KEY = deriveSessionKey(SECRET)
const OTHER_KEY = deriveSessionKey(OTHER_SECRET)
const NOW = Date.UTC(2026, 8, 14, 9, 0, 0)

/** A cookie signed with the real key but carrying a payload of our choosing. */
function signRaw(payload: unknown): string {
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${segment}.${createHmac('sha256', KEY).update(segment).digest('base64url')}`
}

describe('the session cookie', () => {
  it('B1 — sign then verify round trips the claims', () => {
    const cookie = signSessionCookie(KEY, { uid: 583231, sub: 'octocat' }, NOW)
    const verdict = verifySessionCookie(KEY, cookie, NOW)
    expect(verdict).toEqual({ ok: true, claims: { v: 1, uid: 583231, sub: 'octocat', exp: NOW + SESSION_TTL_MS } })
  })

  it('B2 — a cookie signed under a key derived from a DIFFERENT client secret is bad-signature', () => {
    const cookie = signSessionCookie(OTHER_KEY, { uid: 1, sub: 'octocat' }, NOW)
    expect(verifySessionCookie(KEY, cookie, NOW)).toEqual({ ok: false, reason: 'bad-signature' })
    // …and the two keys really are different, so the assertion above is not vacuous.
    expect(KEY.equals(OTHER_KEY)).toBe(false)
  })

  it('B3 — one flipped character in the payload segment is bad-signature', () => {
    const cookie = signSessionCookie(KEY, { uid: 1, sub: 'octocat' }, NOW)
    const cut = cookie.indexOf('.')
    const head = cookie.slice(0, cut)
    const flipped = `${head.slice(0, -1)}${head.endsWith('A') ? 'B' : 'A'}${cookie.slice(cut)}`
    expect(flipped).not.toBe(cookie)
    expect(verifySessionCookie(KEY, flipped, NOW)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('B4 — both sides of the expiry, against an exp COMPUTED from SESSION_TTL_MS', () => {
    const cookie = signSessionCookie(KEY, { uid: 1, sub: 'octocat' }, NOW)
    const verdict = verifySessionCookie(KEY, cookie, NOW)
    expect(verdict.ok).toBe(true)
    const exp = verdict.ok ? verdict.claims.exp : 0
    // The TTL is read off the cookie, so changing the constant without changing
    // the assertion cannot leave this test passing at any TTL.
    expect(exp).toBe(NOW + SESSION_TTL_MS)

    expect(verifySessionCookie(KEY, cookie, exp - 1).ok).toBe(true)
    expect(verifySessionCookie(KEY, cookie, exp)).toEqual({ ok: false, reason: 'expired' })
    expect(verifySessionCookie(KEY, cookie, exp + 1)).toEqual({ ok: false, reason: 'expired' })
  })

  it('B5 — absent, malformed and an unknown v are four different answers, not one', () => {
    expect(verifySessionCookie(KEY, undefined, NOW)).toEqual({ ok: false, reason: 'absent' })
    expect(verifySessionCookie(KEY, '', NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySessionCookie(KEY, 'nodothere', NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySessionCookie(KEY, 'a.b.c', NOW)).toEqual({ ok: false, reason: 'malformed' })

    // A correctly signed cookie whose version this build does not know is
    // malformed, never silently upcast — the contract wave 8 inherits.
    const future = signRaw({ v: 2, uid: 1, sub: 'octocat', exp: NOW + SESSION_TTL_MS })
    expect(verifySessionCookie(KEY, future, NOW)).toEqual({ ok: false, reason: 'malformed' })

    // …and a v:1 payload missing its identity is malformed too.
    expect(verifySessionCookie(KEY, signRaw({ v: 1, sub: 'octocat', exp: NOW + 1000 }), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(verifySessionCookie(KEY, signRaw({ v: 1, uid: 1, sub: '', exp: NOW + 1000 }), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('B7 — repetition: the same (key, claims, now) signs to the same string, and one cookie verifies identically three times', () => {
    const first = signSessionCookie(KEY, { uid: 7, sub: 'octocat' }, NOW)
    const second = signSessionCookie(KEY, { uid: 7, sub: 'octocat' }, NOW)
    expect(second).toBe(first)

    const verdicts = [
      verifySessionCookie(KEY, first, NOW),
      verifySessionCookie(KEY, first, NOW),
      verifySessionCookie(KEY, first, NOW),
    ]
    expect(verdicts[1]).toEqual(verdicts[0])
    expect(verdicts[2]).toEqual(verdicts[0])
  })
})

describe('the cookie header itself', () => {
  it('B8 — Path, HttpOnly, Secure, SameSite=Lax, and Max-Age in WHOLE SECONDS', () => {
    const header = setCookieHeader(SESSION_COOKIE, 'value', SESSION_TTL_MS)
    expect(header).toBe(`${SESSION_COOKIE}=value; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
    // Seconds, not milliseconds: 12 h is 43200, and never 43200000.
    expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`)
    expect(header).not.toContain(`Max-Age=${SESSION_TTL_MS}`)
    expect(setCookieHeader(OAUTH_STATE_COOKIE, 'v', OAUTH_STATE_TTL_MS)).toContain('Max-Age=600')
  })

  it('B9 — clearing is an empty value and Max-Age=0', () => {
    const header = clearCookieHeader(OAUTH_STATE_COOKIE)
    expect(header).toBe(`${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  })

  it('B6 — parseCookieHeader splits on the FIRST = only, and the first occurrence of a name wins', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
    expect(parseCookieHeader('')).toEqual({})
    expect(parseCookieHeader('a=1')).toEqual({ a: '1' })
    expect(parseCookieHeader('a=1; b=2 ;  c=3')).toEqual({ a: '1', b: '2', c: '3' })
    // A base64 neighbour with padding must come back whole, not truncated at `=`.
    expect(parseCookieHeader('pad=YWJjZA==; a=1')).toEqual({ pad: 'YWJjZA==', a: '1' })
    expect(parseCookieHeader('a=first; a=second')).toEqual({ a: 'first' })
    expect(parseCookieHeader('novalue; a=1')).toEqual({ a: '1' })
  })
})

describe('the key and the state nonce', () => {
  it('B10 — deriveSessionKey refuses an empty secret, and is otherwise 32 deterministic bytes', () => {
    expect(() => deriveSessionKey('')).toThrow(/client secret/)
    const again = deriveSessionKey(SECRET)
    expect(again.length).toBe(32)
    expect(again.equals(KEY)).toBe(true)
    expect(deriveSessionKey(OTHER_SECRET).equals(KEY)).toBe(false)
    // The derived key is not the secret, so it cannot be substituted for one.
    expect(KEY.toString('utf8')).not.toBe(SECRET)
  })

  it('B11 — verifyStateCookie is false for every way it can fail, and throws on none of them', () => {
    const issued = issueOauthStateCookie(KEY, NOW)
    expect(issued.setCookie.startsWith(`${OAUTH_STATE_COOKIE}=`)).toBe(true)
    expect(verifyStateCookie(KEY, undefined, issued.nonce, NOW)).toBe(false)
    expect(verifyStateCookie(KEY, issued.setCookie.split(';')[0]?.split('=')[1], undefined, NOW)).toBe(false)

    const value = parseCookieHeader(issued.setCookie.split(';')[0])[OAUTH_STATE_COOKIE]
    expect(verifyStateCookie(KEY, value, issued.nonce, NOW)).toBe(true)
    expect(verifyStateCookie(KEY, value, 'not-the-nonce-but-same-len'.slice(0, issued.nonce.length), NOW)).toBe(false)
    // A nonce of a DIFFERENT length is false, not a RangeError out of timingSafeEqual.
    expect(verifyStateCookie(KEY, value, `${issued.nonce}x`, NOW)).toBe(false)
    expect(verifyStateCookie(KEY, value, issued.nonce.slice(0, 4), NOW)).toBe(false)
    // Expired, and signed under the wrong key.
    expect(verifyStateCookie(KEY, value, issued.nonce, NOW + OAUTH_STATE_TTL_MS)).toBe(false)
    expect(verifyStateCookie(OTHER_KEY, value, issued.nonce, NOW)).toBe(false)
    // …and it really was true a millisecond before it expired.
    expect(verifyStateCookie(KEY, value, issued.nonce, NOW + OAUTH_STATE_TTL_MS - 1)).toBe(true)
  })

  it('B11b — two issues give two different nonces, so a captured one is not a forever key', () => {
    expect(issueOauthStateCookie(KEY, NOW).nonce).not.toBe(issueOauthStateCookie(KEY, NOW).nonce)
  })
})
