import type { Fetch } from '../../auth/github-app.js'
import { checkOrgMembership } from '../../auth/membership.js'
import { SESSION_COOKIE, deriveSessionKey, parseCookieHeader, verifySessionCookie } from '../../auth/session.js'
import type { TeamConfig } from '../../config/config.js'
import { type MintedIngestKey, mintIngestKey } from '../../keys/mint.js'
import { ENV_PROJECT } from '../../keys/seed.js'
import type { IngestKeysPort } from '../../storage/contract.js'
import { escapeHtml } from '../escape.js'
import { REFUSAL_TEXT, type ViewRefusal, type ViewResponse, statusForViewRefusal } from '../questions.js'

/**
 * A MEMBER MINTS A PROJECT KEY, AND SEES IT EXACTLY ONCE (#560, prd-51 ruling 8, wave 12).
 *
 * Ruling 8's two planes touch at exactly one human action: *"a member mints a key in the viewer
 * and pastes it once into `rhizomorph connect team`"*. This module is that viewer. Until now
 * `../../keys/mint.ts` served `deploy/init.sh`'s first key and the tests, and the ruling's own
 * sentence was unshipped.
 *
 * ## TWO ROWS ON ONE PATH, AND WHY THE GET EXISTS
 *
 * `GET /v1/rhizomorph/keys?project=<id>` renders a form; `POST` to the same address mints. The
 * split is not decoration:
 *
 * - **Minting is a write, so it cannot be the GET.** A GET that mints fires on a refresh, a
 *   prefetch, a link preview and a back-button restore, and each one would leave a live key in
 *   `ingest_keys` while "shown once" degraded into "shown once per accidental navigation".
 * - **Without the GET there is no viewer.** A POST-only route is reachable by `curl` and by
 *   nothing a member can click, so ruling 8's sentence would still not be true.
 * - **"Sees it exactly once" is only assertable against a GET.** The claim is that coming back to
 *   the page does not show the key again — and this surface holds nothing between requests, so a
 *   re-GET is byte-identical to the page before the mint.
 *
 * ## THE ORDER IS THE CLAIM: mint, INSERT, then take
 *
 * The digest is stored **before** the plaintext is yielded. If the insert fails, the value is
 * never shown and the member is told to retry — they never walk away holding a key this server
 * does not know, which would refuse at ingest with *"unknown key"* and nothing anywhere saying
 * why. {@link MintedIngestKey.takePlaintext} is called **exactly once**, on the last step, and
 * `mint.test.ts` counts the calls through {@link MintDeps.mintKey} rather than trusting this
 * paragraph.
 *
 * Nothing else ever holds the value: no operator note carries it, the row has no field that could
 * (`IngestKeyRow` declares none), and this module has no state outside a call.
 *
 * ## MINTING DOES NOT REVOKE
 *
 * `../../keys/seed.ts` revokes on rotation because a deployment has exactly one *seeded* key and
 * re-seeding a different digest is what "rotate" means there. A member minting a second key for a
 * second machine is not that, and revoking here would silently kill a colleague's shipper.
 * Revocation from the viewer is its own act and is not in this commit.
 *
 * ## THE GATE IS CONSUMED, NOT RE-DERIVED — and it is re-run at the moment of the mint
 *
 * `checkOrgMembership` is #169's own 204/404 check, called per request: a 404 is
 * `no-such-membership`, *"also what a pending, never-accepted invite looks like"*, so a pending
 * invitee is refused. `../../auth/session.ts`'s header demands exactly this of this surface — a
 * stateless cookie cannot be revoked before it expires, so *"the key-mint surface must re-run
 * `checkOrgMembership` at the moment of the mint"* rather than trust it.
 *
 * The refusal vocabulary is `../questions.ts`'s, **imported rather than copied**: same seven
 * reasons, same seven strings, same status table. One reason is added here and nowhere else —
 * see {@link MintRefusal}.
 *
 * ## MINTING IS A WRITE FROM A BROWSER — what defends it, and why not the mutation guard
 *
 * ADR-0008's guard (loopback bind, loopback `Host`, `Origin`, `Content-Type`, a per-process
 * capability token) and ADR-0012's in-band delivery of that token are the **local** server's, and
 * neither transfers:
 *
 * - ADR-0008's threat model is another local process on the same machine, defended by binding
 *   `127.0.0.1`. This server binds `0.0.0.0` behind Caddy on a public name by design
 *   (`deploy/compose.yml`, `deploy/Caddyfile`), so a loopback `Host` assertion would refuse every
 *   real request.
 * - ADR-0012's token is per process and delivered to whatever can already `GET /` — it separates
 *   "has the page" from "has not". Here that job is already done, and done strictly better, by the
 *   signed session cookie: `HttpOnly`, scoped to one member, and re-validated against GitHub
 *   organisation membership on every request. A second secret proving strictly less is not a
 *   protection.
 *
 * What actually defends the mint, in the order it bites:
 *
 * 1. **`SameSite=Lax` on the session cookie** (`../../auth/session.ts`). A cross-site POST — form,
 *    `fetch`, image, anything — does not carry a Lax cookie, so a forged request arrives with no
 *    session and is refused before any other check.
 * 2. **{@link sameOrigin}, this module's own check**, because the first defence is a browser
 *    policy and this one is the server's. When an `Origin` header is present its host must equal
 *    the request's own `Host`. An **absent** `Origin` is allowed, which is ADR-0008's own recorded
 *    choice — *"the guard also deliberately permits requests with no `Origin` header, for
 *    non-browser callers"* — and costs nothing: browsers always send `Origin` on a POST, and a
 *    non-browser caller sets any value it likes, so requiring presence refuses honest CLI callers
 *    and stops no attacker.
 * 3. **The gate.** A forged POST that somehow carried a session still faces GitHub on that request.
 *
 * **Recorded as ADR-0059.** This docblock first said the decision was deliberately not an ADR — a
 * five-line predicate under a gate the ruling already fixed. That describes the code correctly and
 * applies the wrong test: `docs/adr/README.md` asks whether a rejected alternative can be named,
 * and two can (ADR-0008's guard as written, and a per-request CSRF token). The size of the diff is
 * not the size of the decision, and this is the server's first browser-reached write.
 */

/**
 * `../questions.ts`'s seven reasons, plus the one only a write has.
 *
 * `'cross-origin'` is declared here rather than widened into `ViewRefusal` for two reasons that
 * point the same way: `view/questions.ts` is another lane's file, and its test derives the refusal
 * list from `REFUSAL_TEXT`'s keys, so a reason the read pages can never produce would be a member
 * of their union that nothing there could reach.
 */
export type MintRefusal = ViewRefusal | 'cross-origin'

/**
 * The seven shared strings, spread from `REFUSAL_TEXT` rather than retyped, so there is exactly
 * one copy of each in the package and `mint.test.ts` asserts the identity per reason.
 */
export const MINT_REFUSAL_TEXT: Readonly<Record<MintRefusal, string>> = {
  ...REFUSAL_TEXT,
  'cross-origin':
    'That request did not come from this site, so nothing was minted. Open the page here and try again.',
}

/** 403 for the one reason this module owns; every other reason keeps the status the read pages give it. */
export function statusForMintRefusal(reason: MintRefusal): number {
  return reason === 'cross-origin' ? 403 : statusForViewRefusal(reason)
}

/** What {@link mintIngestKey} is, as a seam a test can wrap to count {@link MintedIngestKey.takePlaintext}. */
export type MintKey = (request: { projectId: string; nowMs: number }) => MintedIngestKey

export interface MintDeps {
  /** One method, and it is a write. A port that cannot read is a port that cannot leak a stored key. */
  readonly storage: Pick<IngestKeysPort, 'insertIngestKey'>
  /** The one project this deployment holds, or `''` for none. Defaults to `RZ_TEAM_PROJECT`. */
  readonly deploymentProject?: string | undefined
  readonly config: TeamConfig
  readonly fetch: Fetch
  readonly now: () => number
  /**
   * Defaults to `../../keys/mint.ts`'s `mintIngestKey`. Injected only by tests — the same seam
   * `mintIngestKey` itself has in `randomHex`, and for the same reason: *"shown once"* is a claim
   * about how many times a method is called, so the test has to be able to count.
   */
  readonly mintKey?: MintKey | undefined
}

export interface MintRequest {
  readonly cookieHeader: string | undefined
  /** `?project=` — named by the caller, exactly as the three questions name it. */
  readonly project: string | undefined
  /** `page` is the GET; `mint` is the POST. The only act that writes. */
  readonly act: 'page' | 'mint'
  /** `Origin:` as presented, or `undefined`. See {@link sameOrigin}. */
  readonly origin?: string | undefined
  /** `Host:` as presented — what an `Origin` must agree with. */
  readonly host?: string | undefined
  /** Where the form posts. Built by the adapter, which is the only layer that knows a path. */
  readonly formAction: string
}

function page(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '</head><body>',
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    '</body></html>',
  ].join('')
}

function refusal(reason: MintRefusal, operatorNote?: string): ViewResponse {
  return {
    status: statusForMintRefusal(reason),
    headers: { 'content-type': 'text/html; charset=utf-8' },
    // Authored here and in `../questions.ts`; the only HTML in this module not escaped, because
    // it contains no caller data at all.
    html: page('rhizomorph', `<p>${MINT_REFUSAL_TEXT[reason]}</p>`),
    operatorNote,
  }
}

/**
 * Whether a presented `Origin` names the same host the request was addressed to.
 *
 * `true` when no `Origin` was sent — see the module header's point 2. The **host** is compared and
 * the scheme is not: TLS terminates at Caddy, so this process cannot know its own public scheme,
 * and comparing one would be a guess that fails closed in production. `Host` rather than
 * `X-Forwarded-Host` because Caddy's `reverse_proxy` passes the original `Host` through unchanged,
 * so it is the public name the browser's `Origin` names.
 */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  if (host === undefined || host === '') return false
  let presented: URL
  try {
    presented = new URL(origin)
  } catch {
    // `null` is a real Origin value (a sandboxed frame, a redirected POST). It is not this host.
    return false
  }
  return presented.host === host
}

/** The form. No inputs at all, so the POST carries no body and there is nothing to parse. */
export function renderMintForm(formAction: string): string {
  return page(
    'Mint an ingest key',
    [
      '<p>An ingest key lets one machine ship this project&#39;s record to this server.</p>',
      `<form method="post" action="${escapeHtml(formAction)}">`,
      '<button type="submit">Mint a key</button>',
      '</form>',
      '<p>The value is shown once, on the next page only. This server keeps only its SHA-256, ' +
        'so a lost key is replaced rather than recovered.</p>',
    ].join(''),
  )
}

/**
 * The key, rendered once.
 *
 * Takes a plaintext that has **already** been yielded by the caller, so this function cannot be
 * the place a second `takePlaintext` sneaks in: it has no minted object to ask.
 */
export function renderMintedKey(plaintext: string, project: string): string {
  return page(
    'Your new ingest key',
    [
      '<p><strong>This is the only time this value is shown.</strong> Copy it now — this server ' +
        'keeps only its SHA-256 and cannot show it again.</p>',
      `<pre><code>${escapeHtml(plaintext)}</code></pre>`,
      `<p>Paste it into <code>rhizomorph connect team &lt;url&gt; --project ${escapeHtml(project)}</code>, ` +
        'which reads it on stdin and never from argv.</p>',
    ].join(''),
  )
}

/**
 * The gate, then the act. Never throws — a failure is a refusal.
 *
 * Mirrors `../questions.ts`'s `handleQuestion` step for step down to the project narrowing, and
 * then diverges exactly where a write does: the origin check, the insert, and the one yield.
 */
export async function handleMint(deps: MintDeps, request: MintRequest): Promise<ViewResponse> {
  const clientSecret = deps.config.githubClientSecret.value
  if (clientSecret === '') return refusal('unconfigured')

  const cookies = parseCookieHeader(request.cookieHeader)
  const session = verifySessionCookie(deriveSessionKey(clientSecret), cookies[SESSION_COOKIE], deps.now())
  // Every session failure is the same answer to the caller: sign in. The REASON is the operator's.
  if (!session.ok) return refusal('no-session', `session rejected: ${session.reason}`)

  const membership = await checkOrgMembership(deps.config, session.claims.sub, { fetch: deps.fetch, now: deps.now })
  if (membership.status === 'unconfigured') return refusal('unconfigured')
  if (membership.status === 'error') return refusal('membership-error', membership.error)
  if (membership.status === 'not-a-member') {
    // #169: `no-such-membership` is ALSO a pending, never-accepted invite. Same answer — and here
    // the answer withholds authority rather than rows, which is why it is re-asserted at this layer.
    return refusal('not-a-member', `not a member: ${membership.reason}`)
  }

  const project = request.project
  if (project === undefined || project === '') return refusal('no-project')

  // The same narrowing `handleQuestion` applies, read the same way and for the same reason: a new
  // `TeamConfig` value would move `deploy/report.test.ts`'s `unsetCount`, which is another lane's.
  const deploymentProject = deps.deploymentProject ?? process.env[ENV_PROJECT] ?? ''
  if (deploymentProject !== '' && project !== deploymentProject) return refusal('wrong-project')

  const headers = { 'content-type': 'text/html; charset=utf-8' }

  if (request.act === 'page') {
    return { status: 200, headers, html: renderMintForm(request.formAction) }
  }

  // THE ONE CHECK A READ PAGE DOES NOT NEED. It sits after the gate rather than before it so that
  // a caller with no session is told to sign in — the useful answer — rather than being told about
  // an origin they got right.
  if (!sameOrigin(request.origin, request.host)) {
    return refusal('cross-origin', `cross-origin mint refused: origin ${String(request.origin)} is not ${String(request.host)}`)
  }

  const minted = (deps.mintKey ?? mintIngestKey)({ projectId: project, nowMs: deps.now() })

  // THE DIGEST FIRST. A failed insert must not have shown anybody a key — see the module header.
  try {
    await deps.storage.insertIngestKey(minted.row)
  } catch (cause) {
    return refusal('storage-error', `minting a key for ${project} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  // …and the one yield, on the last step. A second call throws by construction (ruling 8).
  return { status: 200, headers, html: renderMintedKey(minted.takePlaintext(), project) }
}
