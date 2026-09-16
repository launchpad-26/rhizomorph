import type { Fetch } from '../auth/github-app.js'
import { checkOrgMembership } from '../auth/membership.js'
import { SESSION_COOKIE, deriveSessionKey, parseCookieHeader, verifySessionCookie } from '../auth/session.js'
import type { TeamConfig } from '../config/config.js'
import { ENV_PROJECT } from '../keys/seed.js'
import type { CollisionRow, LaneRow, QuestionsPort, SpendRow } from '../storage/contract.js'
import { escapeHtml } from './escape.js'

/**
 * THE THREE QUESTIONS, ANSWERED IN A BROWSER (#557, prd-51 wave 11).
 *
 * *Where is work*, *what does it cost*, *who is stuck* — the questions the PRD's Problem section
 * says exist nowhere today because no record crosses a machine boundary.
 *
 * ## READ-ONLY, AND STRUCTURALLY SO
 *
 * ADR-0001's read-only-observer discipline reaches here: these handlers hold a
 * {@link QuestionsPort}, which has three read methods and nothing else. There is no mutation to
 * forget to guard, because the type the handler is given cannot express one.
 *
 * ## THE GATE IS THE SESSION, THEN THE ORGANISATION — AND A PENDING INVITEE IS NOT A MEMBER
 *
 * A valid session cookie says *who* the caller is; it does not say they are still in the
 * organisation. So membership is re-checked per request against GitHub. `#169`'s case is the
 * one worth naming: `auth/membership.ts` documents a 404 from the membership GET as
 * `no-such-membership`, *"also what a pending, never-accepted invite looks like"*. An invitation
 * that was sent and never accepted therefore reads as not-a-member here, which is the correct
 * answer and the one a reasonable implementation gets wrong.
 *
 * `unconfigured` and `error` are NOT collapsed into that refusal, following
 * `statusForSignInRefusal`'s discipline: a deployment with no GitHub App is a valid state that
 * should say so, and a credential mint that failed is the operator's problem rather than a
 * statement about the caller.
 */

export type ViewRefusal =
  | 'no-session'
  | 'not-a-member'
  | 'unconfigured'
  | 'membership-error'
  | 'no-project'
  | 'wrong-project'
  | 'storage-error'

export interface ViewResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly html: string
  /** For `onError`. Never reaches the wire — a membership failure names a token and a host. */
  readonly operatorNote?: string | undefined
}

export interface QuestionsDeps {
  readonly storage: QuestionsPort
  /** The one project this deployment holds, or `''` for none. Defaults to `RZ_TEAM_PROJECT`. */
  readonly deploymentProject?: string | undefined
  readonly config: TeamConfig
  readonly fetch: Fetch
  readonly now: () => number
}

export interface QuestionsRequest {
  readonly cookieHeader: string | undefined
  /**
   * `?project=` — which project to read, named by the caller.
   *
   * NOT an authorisation boundary: any member of the organisation may name any project this
   * deployment holds, and `RZ_TEAM_PROJECT` narrows it to one only when that variable is set.
   * See {@link handleQuestion} and the port's docblock.
   */
  readonly project: string | undefined
}

export type Question = 'where' | 'cost' | 'stuck'

/** One table, the shape `statusForSignInRefusal` already has. */
export function statusForViewRefusal(reason: ViewRefusal): number {
  switch (reason) {
    case 'no-session':
      return 401
    case 'not-a-member':
      return 403
    case 'no-project':
      return 400
    case 'wrong-project':
      return 404
    case 'unconfigured':
      return 503
    case 'membership-error':
      return 502
    case 'storage-error':
      return 503
  }
}

export const REFUSAL_TEXT: Readonly<Record<ViewRefusal, string>> = {
  'no-session': 'Sign in to see this. Start at /auth/github/start.',
  'not-a-member': 'This page is for members of the organisation.',
  'no-project': 'Name the project: add ?project=&lt;id&gt; to the address.',
  'wrong-project': 'This deployment does not hold that project.',
  unconfigured: 'This deployment has no GitHub App configured, so it cannot tell who you are yet.',
  'membership-error': 'Could not check your membership just now. Try again shortly.',
  'storage-error': 'Could not read the record just now. Try again shortly.',
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

function refusal(reason: ViewRefusal, operatorNote?: string): ViewResponse {
  return {
    status: statusForViewRefusal(reason),
    headers: { 'content-type': 'text/html; charset=utf-8' },
    // The refusal text is authored here and is the only HTML in this module not escaped,
    // because it contains no caller data at all.
    html: page('rhizomorph', `<p>${REFUSAL_TEXT[reason]}</p>`),
    operatorNote,
  }
}

function table(headers: readonly string[], rows: readonly (readonly string[])[], empty: string): string {
  if (rows.length === 0) return `<p>${escapeHtml(empty)}</p>`
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function whenMs(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString()
}

export function renderWhere(rows: readonly LaneRow[]): string {
  return page(
    'Where is work',
    table(
      ['Lane', 'State', 'Worktree', 'Last event'],
      rows.map((r) => [r.lane, r.state, r.worktree ?? '—', whenMs(r.lastEventTsMs)]),
      'No lanes have reported yet.',
    ),
  )
}

export function renderCost(rows: readonly SpendRow[]): string {
  return page(
    'What does it cost',
    table(
      ['Day', 'Cost (USD)', 'Events'],
      // `costUsd` is printed as the exact decimal string storage returned it as.
      rows.map((r) => [r.day, r.costUsd, String(r.events)]),
      'No spend has been recorded yet.',
    ),
  )
}

export function renderStuck(rows: readonly CollisionRow[]): string {
  return page(
    'Who is stuck',
    table(
      ['Path', 'Lanes', 'First seen', 'Last seen'],
      rows.map((r) => [r.path, r.lanes.join(', '), whenMs(r.firstSeenMs), whenMs(r.lastSeenMs)]),
      'No collisions have been seen.',
    ),
  )
}

/** The gate, then the read, then the page. Never throws — a failure is a refusal. */
export async function handleQuestion(
  deps: QuestionsDeps,
  question: Question,
  request: QuestionsRequest,
): Promise<ViewResponse> {
  const clientSecret = deps.config.githubClientSecret.value
  if (clientSecret === '') return refusal('unconfigured')

  const cookies = parseCookieHeader(request.cookieHeader)
  const session = verifySessionCookie(deriveSessionKey(clientSecret), cookies[SESSION_COOKIE], deps.now())
  // Every session failure — absent, malformed, bad-signature, expired — is the same
  // answer to the caller: sign in. The REASON is the operator's, not the caller's.
  if (!session.ok) return refusal('no-session', `session rejected: ${session.reason}`)

  const membership = await checkOrgMembership(deps.config, session.claims.sub, { fetch: deps.fetch, now: deps.now })
  if (membership.status === 'unconfigured') return refusal('unconfigured')
  if (membership.status === 'error') return refusal('membership-error', membership.error)
  if (membership.status === 'not-a-member') {
    // #169: `no-such-membership` is ALSO a pending, never-accepted invite. Same answer.
    return refusal('not-a-member', `not a member: ${membership.reason}`)
  }

  const project = request.project
  if (project === undefined || project === '') return refusal('no-project')

  /**
   * THE DEPLOYMENT'S OWN PROJECT, WHEN IT HAS ONE.
   *
   * `deploy/serve.ts` seeds one project's ingest key from `RZ_TEAM_PROJECT`, so a deployment
   * configured that way holds exactly one project and a request naming a different one is
   * asking for something that cannot be there. Read from `process.env` rather than
   * `TeamConfig` for the same reason `serve.ts` reads it that way — a new config value moves
   * `deploy/report.test.ts`'s `unsetCount`, which is another lane's file.
   *
   * This narrows; it does not authorise. With the variable unset, any member may name any
   * project, and that is stated rather than implied — per-project authorisation needs a
   * per-project membership model this deployment does not have.
   */
  const deploymentProject = deps.deploymentProject ?? process.env[ENV_PROJECT] ?? ''
  if (deploymentProject !== '' && project !== deploymentProject) return refusal('wrong-project')

  const headers = { 'content-type': 'text/html; charset=utf-8' }

  /**
   * A STORAGE FAILURE IS A REFUSAL, NOT A PROCESS EXIT (found in review of #574).
   *
   * These three reads used to sit outside any try/catch while this function's docblock promised
   * *"Never throws"*. It did: a rejecting read propagated through `writeView` into
   * `createTeamListener`'s async request handler, which has no handler either — and node 22,
   * both the pinned engine and the declared minimum, **terminates the process** on an unhandled
   * rejection from an async listener. So one database blip, on a page any org member can reach,
   * took the ingest plane down with the read plane.
   *
   * The sibling was one screen up in the file this issue already edits: `serveIngest` wraps its
   * one storage call and answers 503 with an operator note. This mirrors that rather than
   * inventing a shape — same status, same split between what the caller sees and what the
   * operator reads, because the database's own sentence names a host, a port and a relation.
   */
  try {
    switch (question) {
      case 'where':
        return { status: 200, headers, html: renderWhere(await deps.storage.readLaneState(project)) }
      case 'cost':
        return { status: 200, headers, html: renderCost(await deps.storage.readSpendByDay(project)) }
      case 'stuck':
        return { status: 200, headers, html: renderStuck(await deps.storage.readCollisions(project)) }
    }
  } catch (cause) {
    return refusal('storage-error', `reading ${question} for ${project} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
