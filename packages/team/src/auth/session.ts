import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * A TEAM-SERVER SESSION IS A SIGNED COOKIE, NOT A ROW (prd-51 ruling 8's human
 * plane, as amended 2026-09-08).
 *
 * A session carries one fact — *this browser proved it is GitHub account `uid`
 * (login `sub`), and that proof expires at `exp`* — and an HMAC over that fact
 * carries it without anything being read back. #487's prohibition is mechanical
 * rather than stylistic: three files pin the tracked migration id set
 * independently, and wave 8's retention work spends this PRD's next migration,
 * so a `sessions` table here is a scheduled collision. It is also not needed.
 *
 * ## Where the key comes from, and why it is derived rather than configured
 *
 * `HKDF-SHA256(githubClientSecret)` under a fixed salt and info label. The
 * client secret is already required for the flow the session comes out of, so
 * the key exists exactly when the routes are configured and never when they are
 * not; the label means the derived key is not the secret and cannot be
 * substituted for it; and rotating the client secret invalidates live sessions,
 * which is the correct direction for a rotation to push.
 *
 * Rejected, each for a reason:
 *
 * - **A new RZ_TEAM_SESSION_SECRET environment variable.** It adds a deployment step that can be
 *   forgotten, producing a server that boots cleanly and cannot sign anyone in.
 * - **A random key per boot.** Every restart signs everyone out and two replicas
 *   reject each other's cookies — invisible in test, intermittent in production.
 * - **The app private key.** That key is the app's identity across the whole
 *   installation, so a forgery oracle on it is strictly worse than one on the
 *   client secret, which is scoped to exactly this flow.
 *
 * {@link deriveSessionKey} throws on an empty secret. That is load-bearing: an
 * unconfigured deployment can never mint a signable session. The handlers refuse
 * with a 503 long before reaching it, so the throw is the belt, not the braces.
 *
 * ## What the cookie proves, and what it does NOT — the contract wave 8 inherits
 *
 * **It proves** that at `exp - SESSION_TTL_MS` this browser held a GitHub
 * credential for `uid`, and that **at that moment** `uid` was a member of the
 * org.
 *
 * **It does not prove that they are still a member.** A stateless cookie cannot
 * be revoked before it expires, so up to {@link SESSION_TTL_MS} of membership
 * lag is possible — someone removed from the org keeps a working cookie until it
 * expires. That is acceptable for a read-only viewer and is **not** acceptable
 * for anything that grants or spends authority: **wave 8's key-mint surface must
 * re-run `checkOrgMembership` at the moment of the mint** rather than trust this
 * cookie. If wave 8 wants revocation for the viewer too, that is the `sessions`
 * table #487's prohibition defers — a wave-8 decision with its own migration,
 * not a retrofit onto this module.
 *
 * Likewise the `state` nonce is bounded by its 10-minute expiry rather than made
 * single-use. Replaying a captured `state` inside that window is possible in
 * principle; it buys nothing without the matching `code`, which GitHub has
 * already invalidated on its first exchange.
 *
 * `v` exists so wave 8 can add a claim without a flag day. A cookie whose `v` is
 * not `1` is **malformed**, never silently upcast.
 */

/** The session cookie's name. `uid` is the identity; `sub` is the label. */
export const SESSION_COOKIE = 'rz_team_session'

/** The CSRF nonce's cookie, issued by the start route and consumed by the callback. */
export const OAUTH_STATE_COOKIE = 'rz_team_oauth_state'

/** 12 h — one working day, so a member signs in once a day rather than once an hour. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** 10 min — GitHub's own `code` lifetime. A round trip through a sign-in page fits; a stale tab does not. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

const KDF_SALT = 'rhizomorph-team-server'
const KDF_INFO = 'session-hmac-v1'

export interface SessionClaims {
  readonly v: 1
  readonly uid: number
  readonly sub: string
  readonly exp: number
}

export type SessionFailure = 'absent' | 'malformed' | 'bad-signature' | 'expired'

export type SessionVerdict =
  | { readonly ok: true; readonly claims: SessionClaims }
  | { readonly ok: false; readonly reason: SessionFailure }

/**
 * The signing key, derived from the GitHub client secret.
 *
 * Throws on an empty secret rather than deriving a key from nothing — see the
 * module header.
 */
export function deriveSessionKey(clientSecret: string): Buffer {
  if (clientSecret === '') {
    throw new Error('a session key cannot be derived with no GitHub client secret configured')
  }
  return Buffer.from(hkdfSync('sha256', clientSecret, KDF_SALT, KDF_INFO, 32))
}

/** Equal-length `timingSafeEqual`; unequal lengths are `false`, never a `RangeError`. */
function equalStrings(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** `<payload base64url>.<HMAC-SHA256 of that segment, base64url>`. */
function signPayload(key: Buffer, payload: unknown): string {
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${segment}.${createHmac('sha256', key).update(segment).digest('base64url')}`
}

function verifyPayload(
  key: Buffer,
  value: string | undefined,
  nowMs: number,
): { readonly ok: true; readonly payload: Record<string, unknown> } | { readonly ok: false; readonly reason: SessionFailure } {
  if (value === undefined) return { ok: false, reason: 'absent' }

  const parts = value.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const segment = parts[0]
  const signature = parts[1]
  if (segment === undefined || signature === undefined || segment === '' || signature === '') {
    return { ok: false, reason: 'malformed' }
  }

  // The signature is checked BEFORE the payload is parsed: a forged payload must
  // not be able to steer the parse it has not yet earned.
  const expected = createHmac('sha256', key).update(segment).digest('base64url')
  if (!equalStrings(expected, signature)) return { ok: false, reason: 'bad-signature' }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed' }
  }

  const payload = parsed as Record<string, unknown>
  if (payload.v !== 1) return { ok: false, reason: 'malformed' }
  const exp = payload.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: 'malformed' }
  if (nowMs >= exp) return { ok: false, reason: 'expired' }

  return { ok: true, payload }
}

/** Deterministic over `(key, claims, nowMs)` — no nonce, no per-call state. */
export function signSessionCookie(
  key: Buffer,
  claims: Omit<SessionClaims, 'v' | 'exp'>,
  nowMs: number,
): string {
  const full: SessionClaims = { v: 1, uid: claims.uid, sub: claims.sub, exp: nowMs + SESSION_TTL_MS }
  return signPayload(key, full)
}

export function verifySessionCookie(key: Buffer, value: string | undefined, nowMs: number): SessionVerdict {
  const verified = verifyPayload(key, value, nowMs)
  if (!verified.ok) return verified

  const uid = verified.payload.uid
  const sub = verified.payload.sub
  const exp = verified.payload.exp
  if (typeof uid !== 'number' || !Number.isFinite(uid)) return { ok: false, reason: 'malformed' }
  if (typeof sub !== 'string' || sub === '') return { ok: false, reason: 'malformed' }
  if (typeof exp !== 'number') return { ok: false, reason: 'malformed' }

  return { ok: true, claims: { v: 1, uid, sub, exp } }
}

/** A fresh nonce and the `Set-Cookie` that carries it, both from one act. */
export function issueOauthStateCookie(key: Buffer, nowMs: number): { readonly nonce: string; readonly setCookie: string } {
  const nonce = randomBytes(16).toString('base64url')
  const value = signPayload(key, { v: 1, n: nonce, exp: nowMs + OAUTH_STATE_TTL_MS })
  return { nonce, setCookie: setCookieHeader(OAUTH_STATE_COOKIE, value, OAUTH_STATE_TTL_MS) }
}

/**
 * The cookie's nonce and the presented `state` must agree.
 *
 * One boolean, on purpose: every way this can fail is the same refusal
 * (`bad-state`), and a refusal that distinguishes them tells a forger which
 * half they got right.
 */
export function verifyStateCookie(
  key: Buffer,
  value: string | undefined,
  nonce: string | undefined,
  nowMs: number,
): boolean {
  if (nonce === undefined || nonce === '') return false
  const verified = verifyPayload(key, value, nowMs)
  if (!verified.ok) return false
  const carried = verified.payload.n
  if (typeof carried !== 'string' || carried === '') return false
  return equalStrings(carried, nonce)
}

/**
 * `SameSite=Lax` is required, not preferred: the callback is a cross-site
 * top-level GET navigation from `github.com`, and `Strict` would withhold the
 * state cookie on exactly the request that has to read it.
 */
export function setCookieHeader(name: string, value: string, maxAgeMs: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`
}

export function clearCookieHeader(name: string): string {
  return setCookieHeader(name, '', 0)
}

/**
 * `Cookie:` into a record. Splits each pair on the **first** `=` only — a
 * signed cookie's own value is base64url and carries none, but a neighbouring
 * cookie set by something else may, and a bare `split('=')` would truncate it.
 * First occurrence of a name wins.
 */
export function parseCookieHeader(header: string | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  if (header === undefined) return out
  for (const pair of header.split(';')) {
    const trimmed = pair.trim()
    if (trimmed === '') continue
    const cut = trimmed.indexOf('=')
    if (cut <= 0) continue
    const name = trimmed.slice(0, cut).trim()
    if (name === '' || Object.hasOwn(out, name)) continue
    out[name] = trimmed.slice(cut + 1)
  }
  return out
}
