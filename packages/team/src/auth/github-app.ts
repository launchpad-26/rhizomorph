import { sign } from 'node:crypto'

/**
 * ONE INSTALLATION TOKEN, MINTED FROM THE APP'S OWN KEY (ruling 8, amended
 * 2026-09-08 — "the human plane is a GitHub App").
 *
 * `mintInstallationToken` never sees a signed-in person's token and never
 * produces one: it is RS256(app private key) -> a short-lived JWT -> one
 * POST, and the token that comes back speaks for the app's own installation,
 * not for whoever is asking. That is what makes the boundary in
 * `membership.ts` immune to one member granting more than another.
 *
 * No dependency: `node:crypto`'s `sign()` does RS256 directly, and the HTTP
 * client is injected so this module never imports a driver of its own.
 */

/** Structurally `typeof fetch`, so a test can inject a stub with the same shape. */
export type Fetch = typeof fetch

export interface GithubAppCredentials {
  readonly appId: string
  readonly installationId: string
  readonly privateKeyPem: string
}

export type MintTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: string }

const GITHUB_API_VERSION = '2022-11-28'
const USER_AGENT = 'rhizomorph-team-server'

function signJwt(credentials: GithubAppCredentials, nowSeconds: number): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  // 60s backdated per GitHub's own docs, to tolerate clock drift between this
  // host and GitHub's. 600s (10 minutes) is GitHub's maximum `exp` window.
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 600, iss: credentials.appId }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode(header)}.${encode(payload)}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), credentials.privateKeyPem).toString('base64url')
  return `${signingInput}.${signature}`
}

/**
 * RS256 JWT -> `POST /app/installations/{id}/access_tokens` -> the token.
 *
 * Every failure — a malformed key `sign()` rejects, a network failure, a
 * non-201 response, a response with no `token` field — comes back as
 * `{ ok: false, error }` naming the installation token, never as a thrown
 * exception the caller must also guard against.
 *
 * The catch branch names the knob a DOCKER operator can set, because that is the
 * only deployment this server has (ruling 13). compose derives the file variable
 * from a host-path variable and never forwards the inline one, so the line it used
 * to print sent an operator to a knob with no effect. The wording follows
 * `packages/team/deploy/report.ts`, which fixed the same sentence for the boot
 * line, rather than inventing a second voice. This error reaches the operator's
 * stderr only, never the wire — `signin.ts` routes it to operatorNote.
 */
export async function mintInstallationToken(
  credentials: GithubAppCredentials,
  fetchImpl: Fetch,
  now: () => number = () => Date.now(),
): Promise<MintTokenResult> {
  try {
    const jwt = signJwt(credentials, Math.floor(now() / 1000))
    const url = `https://api.github.com/app/installations/${encodeURIComponent(credentials.installationId)}/access_tokens`
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
        'x-github-api-version': GITHUB_API_VERSION,
      },
    })
    if (response.status !== 201) {
      return {
        ok: false,
        error: `the GitHub App installation token mint was refused (status ${response.status}) — check the app id and installation id`,
      }
    }
    const body = (await response.json()) as { token?: unknown }
    if (typeof body.token !== 'string' || body.token === '') {
      return { ok: false, error: 'the GitHub App installation token mint returned no token' }
    }
    return { ok: true, token: body.token }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return {
      ok: false,
      error:
        `the GitHub App installation token could not be minted (${message}) — check ` +
        'RZ_TEAM_GITHUB_INSTALLATION_ID and the private key. Under docker the key is set by ' +
        'RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH in deploy/.env — the HOST path of a readable PEM — ' +
        'then `docker compose up -d`; compose never passes RZ_TEAM_GITHUB_APP_PRIVATE_KEY to this ' +
        'container. Outside docker, set RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE or ' +
        'RZ_TEAM_GITHUB_APP_PRIVATE_KEY directly.',
    }
  }
}
