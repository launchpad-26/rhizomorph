import type { TeamConfig } from '../config/config.js'
import { type Fetch, type GithubAppCredentials, mintInstallationToken } from './github-app.js'

/**
 * THE MEMBERSHIP BOUNDARY (ruling 8, amended 2026-09-08).
 *
 * `GET /orgs/{org}/members/{user}` on an installation token: 204 is a member,
 * anything else is not. Every non-204 collapses to the same verdict —
 * `not-a-member` — but the *reason* stays distinguishable, because a 404 (no
 * such membership, which is also what a never-accepted pending invite looks
 * like), a 401/403 (GitHub rejected this app's own installation token) and a
 * network failure are different operational facts a report may need to tell
 * apart, even though none of them grants access.
 *
 * **What this module is not**: it never accepts a signed-in person's token —
 * there is no parameter for one — so the check cannot be widened by any one
 * member's own grant. It is also not the credential-mint failure path: if
 * `mintInstallationToken` itself fails (bad key, bad installation id, GitHub
 * down), that is reported as `{ status: 'error' }`, never folded into
 * `not-a-member` — refusing a real member because the server's own key is
 * misconfigured must be loud, not silent.
 */

export type NotMemberReason =
  /** 404 — also what a pending, never-accepted invite looks like. */
  | 'no-such-membership'
  /** 302 — the user-token-era "not a member" signal; not reachable on an installation token, handled rather than assumed impossible. */
  | 'legacy-redirect'
  /** 401/403 on the membership GET itself. */
  | 'credential-rejected'
  /** The GET request itself failed to complete. */
  | 'network-error'
  /** Any other status. */
  | 'unexpected-response'

export type MembershipCheckResult =
  | { readonly status: 'member' }
  | { readonly status: 'not-a-member'; readonly reason: NotMemberReason }
  /** No app credentials configured — this deployment has not set one up. Not the same fact as `not-a-member`. */
  | { readonly status: 'unconfigured' }
  /** The credential mint itself failed. Never collapsed into `not-a-member`. */
  | { readonly status: 'error'; readonly error: string }

export interface MembershipCheckDeps {
  readonly fetch: Fetch
  readonly now?: (() => number) | undefined
}

const GITHUB_API_VERSION = '2022-11-28'
const USER_AGENT = 'rhizomorph-team-server'

function credentialsFrom(config: TeamConfig): GithubAppCredentials | undefined {
  const appId = config.githubAppId.value
  const installationId = config.githubInstallationId.value
  const privateKeyPem = config.githubAppPrivateKey.value
  const orgLogin = config.githubOrgLogin.value
  if (appId === '' || installationId === '' || privateKeyPem === '' || orgLogin === '') return undefined
  return { appId, installationId, privateKeyPem }
}

/** One organisation, checked on an installation token. Never a boot failure when unconfigured. */
export async function checkOrgMembership(
  config: TeamConfig,
  login: string,
  deps: MembershipCheckDeps,
): Promise<MembershipCheckResult> {
  const credentials = credentialsFrom(config)
  if (credentials === undefined) return { status: 'unconfigured' }

  const mint = await mintInstallationToken(credentials, deps.fetch, deps.now)
  if (!mint.ok) return { status: 'error', error: mint.error }

  const org = config.githubOrgLogin.value
  let response: Awaited<ReturnType<Fetch>>
  try {
    response = await deps.fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`, {
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${mint.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
        'x-github-api-version': GITHUB_API_VERSION,
      },
    })
  } catch {
    return { status: 'not-a-member', reason: 'network-error' }
  }

  if (response.status === 204) return { status: 'member' }
  if (response.status === 404) return { status: 'not-a-member', reason: 'no-such-membership' }
  if (response.status === 302) return { status: 'not-a-member', reason: 'legacy-redirect' }
  if (response.status === 401 || response.status === 403) return { status: 'not-a-member', reason: 'credential-rejected' }
  return { status: 'not-a-member', reason: 'unexpected-response' }
}
