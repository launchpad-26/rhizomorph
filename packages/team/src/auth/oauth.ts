import type { Fetch } from './github-app.js'

/**
 * CODE → USER TOKEN → IDENTITY, AND NOTHING ELSE.
 *
 * The user-to-server half of ruling 8's human plane. What comes out of here is
 * a GitHub login and a numeric account id; the *membership* question is asked
 * somewhere else, on the app's own installation token (`./membership.ts`), so
 * nothing in this module can widen the boundary.
 *
 * ## A used code comes back as HTTP 200
 *
 * `POST /login/oauth/access_token` invalidates a code on its first exchange, and
 * answers a second exchange with **status 200** and a body of
 * `{"error":"bad_verification_code"}`. An implementation that branches on
 * `response.status === 200` alone therefore mints a fresh session on every
 * replay of a captured code. **The body is the verdict, not the status** — this
 * repo has already shipped one defect of exactly that shape (a `302` treated as
 * handled while the real `fetch` had followed the redirect, #169).
 *
 * So `github-refused` covers all three: a non-200 status, a truthy `error` in
 * the body, and an absent or non-string `access_token`.
 *
 * ## The secret and the code go in the body, never the URL
 *
 * A URL reaches proxy logs, browser history and Referer headers; a request
 * body reaches none of them. No failure here interpolates the code, the secret
 * or a thrown message into its reason either — the reasons are three fixed
 * words.
 */

export type OauthFailure = 'github-refused' | 'github-unreachable' | 'no-identity'

const USER_AGENT = 'rhizomorph-team-server'
const GITHUB_API_VERSION = '2022-11-28'

export type ExchangeResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: OauthFailure }

export type IdentityResult =
  | { readonly ok: true; readonly login: string; readonly uid: number }
  | { readonly ok: false; readonly reason: OauthFailure }

export async function exchangeCodeForUserToken(
  clientId: string,
  clientSecret: string,
  code: string,
  fetchImpl: Fetch,
): Promise<ExchangeResult> {
  let body: unknown
  let status: number
  try {
    const response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })
    status = response.status
    body = await response.json()
  } catch {
    // The thrown message does not leave this function: it can carry a URL, and
    // a URL here is adjacent to a secret.
    return { ok: false, reason: 'github-unreachable' }
  }

  if (status !== 200) return { ok: false, reason: 'github-refused' }
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'github-refused' }

  const payload = body as { error?: unknown; access_token?: unknown }
  // GitHub answers a used, expired or wrong-client code with 200 + `error`.
  if (payload.error !== undefined && payload.error !== null && payload.error !== '') {
    return { ok: false, reason: 'github-refused' }
  }
  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    return { ok: false, reason: 'github-refused' }
  }

  return { ok: true, token: payload.access_token }
}

/**
 * `GET /user` on the person's own token.
 *
 * **`uid` is captured on purpose.** A GitHub login can be renamed and a freed
 * login can be taken by somebody else; the numeric id cannot. Both go in the
 * session so wave 8 can key on the stable one and still show the readable one.
 */
export async function resolveGithubIdentity(userToken: string, fetchImpl: Fetch): Promise<IdentityResult> {
  let body: unknown
  let status: number
  try {
    const response = await fetchImpl('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${userToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
        'x-github-api-version': GITHUB_API_VERSION,
      },
    })
    status = response.status
    if (status === 200) body = await response.json()
  } catch {
    return { ok: false, reason: 'github-unreachable' }
  }

  if (status !== 200) return { ok: false, reason: 'github-refused' }
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'no-identity' }

  const payload = body as { login?: unknown; id?: unknown }
  if (typeof payload.login !== 'string' || payload.login === '') return { ok: false, reason: 'no-identity' }
  if (typeof payload.id !== 'number' || !Number.isFinite(payload.id)) return { ok: false, reason: 'no-identity' }

  return { ok: true, login: payload.login, uid: payload.id }
}
