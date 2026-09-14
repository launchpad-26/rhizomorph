import type { TeamConfig } from '../config/config.js'
import type { Fetch } from './github-app.js'
import { checkOrgMembership } from './membership.js'
import { exchangeCodeForUserToken, resolveGithubIdentity } from './oauth.js'
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearCookieHeader,
  deriveSessionKey,
  issueOauthStateCookie,
  parseCookieHeader,
  setCookieHeader,
  signSessionCookie,
  verifyStateCookie,
} from './session.js'

/**
 * THE TWO HALVES OF A SIGN-IN, PURE OF TRANSPORT (ruling 8's human plane).
 *
 * The same split `../ingest/handle.ts` already has: decoded inputs in, a status,
 * headers and a body out. No `IncomingMessage`, no `ServerResponse`, no storage
 * — `../api/http.ts` is the adapter that turns a socket into these arguments.
 *
 * Both halves live in one module because they share a refusal vocabulary, a
 * nonce contract and a configured-ness check; splitting them would put the
 * issuer and the verifier of one nonce in two files.
 *
 * ## The order of the callback's checks is the design
 *
 * 1. **unconfigured** — so a deployment with no GitHub credentials reaches no
 *    network and derives no key.
 * 2. **no code** — no network.
 * 3. **state** — *before* the exchange, so a forged callback buys no GitHub
 *    round trip. `handleIngest` gives the same reasoning for refusing an unknown
 *    key before a body is decoded.
 * 4. the exchange, 5. the identity read, 6. the membership check.
 *
 * **Cookies on the refusal paths.** Steps 4–6 clear the state cookie, because
 * the nonce has been consumed. Steps 1–3 set **no** `Set-Cookie` at all: a bad
 * or absent state must not delete a cookie a concurrent, legitimate flow is
 * holding.
 *
 * ## A mint failure is never a non-member
 *
 * `checkOrgMembership` reports a failed installation-token mint as
 * `{ status: 'error' }`, and that stays a **500** here, never folded into the
 * 403. Refusing a real member because the server's own key is misconfigured must
 * be loud (#169's own law, and the review finding that pinned it). The mint's
 * own sentence goes to `operatorNote` — the caller at that moment has
 * authenticated with GitHub but is not known to be a member, so the server's
 * internals are the operator's, not theirs.
 *
 * ## Nothing leaks
 *
 * No refusal interpolates the `code`, the user token, the client secret, the
 * installation token, or a thrown message. That is held by a loop in
 * `signin.test.ts` over every case at once, not by care taken at each one.
 *
 * ## The callback never redirects
 *
 * Success is `200 + Set-Cookie`. There is no viewer to redirect to yet, and it
 * makes "no secret in a redirect URL" structurally true rather than carefully
 * true. {@link handleSignInStart} is the half that does redirect, to GitHub's
 * own authorize URL, carrying only a client id and a nonce.
 */

export interface SignInDeps {
  readonly config: TeamConfig
  readonly fetch: Fetch
  readonly now?: (() => number) | undefined
}

export interface CallbackRequest {
  readonly code: string | undefined
  readonly state: string | undefined
  readonly cookieHeader: string | undefined
}

export type SignInRefusal =
  | 'unconfigured'
  | 'no-code'
  | 'bad-state'
  | 'github-refused'
  | 'github-unreachable'
  | 'no-identity'
  | 'not-a-member'
  | 'membership-unconfigured'
  | 'membership-error'

export interface SignInResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[]>>
  readonly body: unknown
  /** For `onError`. Never reaches the wire. */
  readonly operatorNote?: string | undefined
}

/** One table, the shape `../keys/verify.ts`'s `statusForIngestKeyRefusal` already has. */
export function statusForSignInRefusal(reason: SignInRefusal): number {
  switch (reason) {
    case 'unconfigured':
    case 'membership-unconfigured':
      return 503
    case 'no-code':
    case 'bad-state':
      return 400
    case 'github-refused':
      return 401
    case 'not-a-member':
      return 403
    case 'membership-error':
      return 500
    case 'github-unreachable':
    case 'no-identity':
      return 502
  }
}

const SENTENCES: Readonly<Record<SignInRefusal, string>> = {
  unconfigured:
    'this team server has no GitHub sign-in configured, so nobody can sign in to it yet. Set RZ_TEAM_GITHUB_CLIENT_ID and RZ_TEAM_GITHUB_CLIENT_SECRET from the GitHub App and restart.',
  'no-code':
    'that callback carried no authorization code. Start again at /auth/github/start rather than opening the callback directly.',
  'bad-state':
    'that callback could not be matched to a sign-in this server started. Start again at /auth/github/start; a sign-in left open for more than ten minutes has to be restarted.',
  'github-refused':
    'GitHub refused that authorization. An authorization code may be exchanged once and expires quickly, so start again at /auth/github/start.',
  'github-unreachable': 'GitHub could not be reached to complete that sign-in. Try again.',
  'no-identity': 'GitHub accepted that authorization but did not say who it belongs to. Try again.',
  'not-a-member':
    'that GitHub account is not a member of this team server organisation. Membership of the organisation is the whole access boundary — ask an organisation owner for an invitation, and accept it before signing in again.',
  'membership-unconfigured':
    'this team server cannot check organisation membership, so it cannot admit anyone. Set RZ_TEAM_GITHUB_ORG, RZ_TEAM_GITHUB_APP_ID, RZ_TEAM_GITHUB_INSTALLATION_ID and RZ_TEAM_GITHUB_APP_PRIVATE_KEY from the GitHub App and restart.',
  'membership-error':
    'this team server could not check organisation membership, so it refused rather than guessing. This is a server-side fault and not something the person signing in can fix; the operator has the detail.',
}

function refuse(
  reason: SignInRefusal,
  extra: { readonly clearState?: boolean; readonly detail?: Record<string, unknown>; readonly operatorNote?: string } = {},
): SignInResponse {
  return {
    status: statusForSignInRefusal(reason),
    headers: extra.clearState === true ? { 'set-cookie': [clearCookieHeader(OAUTH_STATE_COOKIE)] } : {},
    body: { error: SENTENCES[reason], refusal: reason, ...(extra.detail ?? {}) },
    operatorNote: extra.operatorNote,
  }
}

function configuredOrUndefined(config: TeamConfig): { readonly clientId: string; readonly clientSecret: string } | undefined {
  const clientId = config.githubClientId.value
  const clientSecret = config.githubClientSecret.value
  if (clientId === '' || clientSecret === '') return undefined
  return { clientId, clientSecret }
}

/**
 * The route that issues the nonce. Synchronous; it reaches no network.
 *
 * The client secret is checked even though the redirect does not use it: a
 * deployment that can start a flow it can never finish should refuse at the
 * start, where the operator sees it, not at the callback.
 */
export function handleSignInStart(deps: SignInDeps): SignInResponse {
  const configured = configuredOrUndefined(deps.config)
  if (configured === undefined) return refuse('unconfigured')

  const nowMs = (deps.now ?? Date.now)()
  const state = issueOauthStateCookie(deriveSessionKey(configured.clientSecret), nowMs)

  // No `redirect_uri`: the callback URL is registered on the GitHub App itself
  // (prd-51's 2026-09-08 amendment), so omitting it means this code cannot be
  // tricked into pointing GitHub at a different host. No `scope` either — a
  // GitHub App's permissions are the App's, chosen once at creation.
  const query = new URLSearchParams({ client_id: configured.clientId, state: state.nonce })

  return {
    status: 302,
    headers: {
      location: `https://github.com/login/oauth/authorize?${query.toString()}`,
      'set-cookie': [state.setCookie],
    },
    body: { redirectingTo: 'github' },
  }
}

/** GitHub returns a member here. A member gets a session; every other outcome names its reason. */
export async function handleGithubCallback(deps: SignInDeps, request: CallbackRequest): Promise<SignInResponse> {
  const configured = configuredOrUndefined(deps.config)
  if (configured === undefined) return refuse('unconfigured')

  const code = (request.code ?? '').trim()
  if (code === '') return refuse('no-code')

  const key = deriveSessionKey(configured.clientSecret)
  const nowMs = (deps.now ?? Date.now)()
  const cookies = parseCookieHeader(request.cookieHeader)
  if (!verifyStateCookie(key, cookies[OAUTH_STATE_COOKIE], request.state, nowMs)) {
    return refuse('bad-state')
  }

  const exchanged = await exchangeCodeForUserToken(configured.clientId, configured.clientSecret, code, deps.fetch)
  if (!exchanged.ok) return refuse(exchanged.reason, { clearState: true })

  const identity = await resolveGithubIdentity(exchanged.token, deps.fetch)
  if (!identity.ok) return refuse(identity.reason, { clearState: true })

  const membership = await checkOrgMembership(deps.config, identity.login, { fetch: deps.fetch, now: deps.now })
  if (membership.status === 'unconfigured') return refuse('membership-unconfigured', { clearState: true })
  if (membership.status === 'error') {
    return refuse('membership-error', { clearState: true, operatorNote: membership.error })
  }
  if (membership.status === 'not-a-member') {
    return refuse('not-a-member', { clearState: true, detail: { reason: membership.reason } })
  }

  const session = signSessionCookie(key, { uid: identity.uid, sub: identity.login }, nowMs)
  return {
    status: 200,
    headers: {
      'set-cookie': [setCookieHeader(SESSION_COOKIE, session, SESSION_TTL_MS), clearCookieHeader(OAUTH_STATE_COOKIE)],
    },
    body: { signedIn: true, login: identity.login },
  }
}
