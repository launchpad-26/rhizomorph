# s5-identity — borrowed GitHub identity: what it needs, what stays an operator act

Lane of prd-48 (PR #141) research-spike fleet. Read-only `gh api` calls only — no
writes, no auth changes, no OAuth app creation. Box: WSL2 Ubuntu, i9-13900H 20
cores, 31 GiB, load average at test time 6.96 / 1.85 / 0.85 (other lanes active).

## What ran

All commands via `gh api` under the existing local `gh auth` session
(account `KelliherL`), 2026-08-27 17:20 UTC.

```
gh auth status
gh api /user --jq '.login,.id'
gh api /user/memberships/orgs --jq '.[].organization.login'
gh api -i /orgs/launchpad-26/members/KelliherL      # this account, in the org
gh api -i /orgs/launchpad-26/members/octocat        # contrast: not in the org
gh api /user/memberships/orgs --jq '.[] | {org, role, state}'
gh api /rate_limit --jq '.resources.core | {limit,remaining}'
```

## Results

**[EXECUTED] Token and identity**

| Field | Value |
|---|---|
| Account | `KelliherL` (id 179672502) |
| Token scopes | `gist, project, read:org, repo, workflow` |
| Org membership (`/user/memberships/orgs`) | `launchpad-26`, role `member`, state `active` |

**[EXECUTED] Org-membership-check status codes**

| Call | HTTP status |
|---|---|
| `/orgs/launchpad-26/members/KelliherL` (self, is a member) | `204 No Content` |
| `/orgs/launchpad-26/members/octocat` (not a member of this org) | `404 Not Found` |

Response headers on the successful call carried:
`X-Accepted-Oauth-Scopes: read:org, repo, user` and
`X-Oauth-Scopes: gist, project, read:org, repo, workflow` — the request
succeeded on a token that holds `read:org` (also holds `repo`, so this call
alone can't isolate which of the two accepted scopes fired; scope semantics
below are from docs, not inferred from this single call).

**[EXECUTED] Rate limit headroom**: 4968 / 5000 core requests remaining after
this run — six calls cost 32 total combined with prior lane activity on this
token; not a constraint for this spike.

## [REASONED, cite docs.github.com] Scope minimum and flow choice

- **`GET /orgs/{org}/members/{username}` minimum scope is `read:org`.**
  docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
  defines `read:org` as "Read-only access to organization membership,
  organization projects, and team membership" — the narrowest of the three
  org scopes (`read:org` < `write:org` < `admin:org`). `repo` also satisfies
  the endpoint per the `X-Accepted-Oauth-Scopes` header observed above, but
  granting `repo` for a membership check is scope creep — `repo` is full
  read/write on repository contents, wildly beyond what a batch-ingest
  identity check needs.
- **A fine-grained PAT or GitHub App needs the "Organization members"
  permission** (read-only) instead of a classic scope, and — critically — a
  GitHub App must be **installed on the org** before it can see anything,
  which is itself an org-owner act, not something a member can self-serve.
  That makes GitHub Apps a heavier operator dependency than a classic OAuth
  token scoped to `read:org` for this specific check.
- **Web application flow vs device flow, for a server that must not hold a
  client secret in a public binary:** the web app flow's token exchange
  requires the app to present `client_id` **and** `client_secret` to GitHub.
  The device flow does not — "the `client_secret` is not needed for the
  device flow" (docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
  and GitHub names it explicitly for "headless apps, such as CLI tools." A
  rhizomorph ingest client shipped as a binary to contributor machines is
  exactly that case — device flow is the only one of the two that doesn't
  require embedding a secret in something end users hold.
- **Where the client secret lives instead:** a self-hosted team server that
  brokers the OAuth handshake (receiving the device-flow callback, or running
  the web flow itself on the server's own domain) can hold the client secret
  in its own environment — that's the standard model (server-side env var,
  never shipped to a client). The distinction is who possesses the binary:
  a secret in a process the operator alone controls is normal; a secret
  embedded in something distributed to every contributor's machine is not.

## Design paragraph (grounded)

Ingest keys are a **separate credential plane** from GitHub identity, and the
two must never fuse. An ingest key is 32 random bytes, generated server-side,
stored only as its SHA-256 hash (never the raw bytes) with a `rzk_` prefix
shown to the user exactly once at mint time — the same shape as GitHub's own
PATs (`ghp_`/`gho_`) and Stripe's `sk_`, chosen so a leaked key is grep-able by
prefix in logs and secret scanners without the server ever being able to
reproduce the plaintext from what it stores. Revocation is a boolean flag on
the key's row, checked once per ingest batch (not per event) — cheap, and the
"once per batch" cadence bounds the propagation delay of a revocation to one
batch interval, which is the same remedy shape prd-19 uses: state exactly what
is denied and why, not a generic "unauthorized." A refused batch should read
like prd-19's refusal text — naming the exact key prefix and the exact reason
(revoked / expired / unknown), not a bare 401. GitHub OAuth identity answers
**"is this operator allowed to administer the pipeline"**; the ingest key
answers **"is this batch allowed to write."** Fusing them — e.g., minting an
ingest key derived from a GitHub token, or accepting a GitHub token in place
of an ingest key on the batch endpoint — would mean a GitHub token leak (or a
revoked-but-cached org membership) silently becomes a data-plane compromise.
Keeping them separate means revoking one has no effect on the other, and the
ingest endpoint never needs to call out to GitHub's API on the hot path.

## Falsifier verdicts

1. **Does the cohort org (`launchpad-26`) expose membership to the current
   token? — PASS.** [EXECUTED] `GET /orgs/launchpad-26/members/KelliherL`
   returned `204 No Content`, and `/user/memberships/orgs` independently
   confirms `role: member, state: active`. Decided by the two status codes
   above (204 for a real member vs 404 for `octocat`, a control non-member).

2. **Which scope was actually needed? — UNRESOLVED by execution, PASS by
   documentation.** The live token holds both `read:org` and `repo`, and
   GitHub's `X-Accepted-Oauth-Scopes` header lists both as sufficient for this
   endpoint, so the single successful call can't isolate which scope carried
   it — that would need a second token minted with `read:org` alone, which is
   a write/auth action out of scope for this read-only lane. Docs
   (scopes-for-oauth-apps) are unambiguous that `read:org` is the intended
   and minimal scope for org-membership reads; treat this as settled by
   documentation, not by this session's execution.

3. **Name every operator act remaining.**
   - **OAuth App (or GitHub App) registration** — named in the brief as the
     excluded operator act; nothing in this spike substitutes for it.
   - **Org approval of the app, if third-party access restrictions are
     on** — [REASONED, cite docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions]:
     when restrictions are enabled, "organization members and outside
     collaborators cannot authorize OAuth app access to organization
     resources" until an org **owner** approves the specific app. This spike
     did not check whether `launchpad-26` currently has that restriction
     enabled — checking it requires an org-owner-scoped call
     (`GET /orgs/{org}` `members_can_...` fields or the org's security
     settings) that this token may not be authorized to read, and confirming
     either way isn't load-bearing for this note's falsifiers.
   - **GitHub App installation on the org**, if the App route is chosen
     instead of classic OAuth — installing an App onto an org is an
     owner-only act distinct from both registration and access-restriction
     approval; a member's own consent is not sufficient.
   - **Provisioning the client secret into the team server's own
     environment** — a one-time operator deployment step, not automatable
     from a contributor's machine.

## What this did not test

- Single-machine, single-account: only tested against one org (`launchpad-26`)
  and one membership state (active member). Did not test a *pending* (invited
  but not yet accepted) membership, which GitHub also reports distinctly via
  `state: pending` on `/user/memberships/orgs` — that state should probably be
  treated as "not yet an operator" by the ingest gate, but this session did
  not have a pending-invite account to confirm the exact status code shape.
  This is a gap.
  - What did test that shape? `octocat`, but that isolates "the *target* user
    isn't a member" (404), not "the *requesting* token belongs to a pending
    invitee" — those may not produce the same response, and this note doesn't
    know which.
  - Did not exercise device flow or web flow end-to-end (both require
    creating an OAuth app, explicitly the excluded operator act) — the flow
    comparison above is documentation-only, not a live handshake.
  - Did not check `launchpad-26`'s actual third-party-access-restriction
    setting, so falsifier 3's "if third-party restrictions are on" is
    conditional/unconfirmed, not verified either way for this specific org.
  - Ingest-key design (SHA-256 hash storage, `rzk_` prefix, per-batch
    revocation check) is a design proposal, not implemented or tested code —
    no throwaway server was built this lane; budget (~15 min, writing-heavy)
    was spent on the identity-plane questions instead.

## Reproduction

```
mkdir -p ~/rhizomorph-spikes/s5-identity ~/rhizo-spikes/notes
gh auth status
gh api /user --jq '.login,.id'
gh api /user/memberships/orgs --jq '.[] | {org: .organization.login, role, state}'
gh api -i /orgs/launchpad-26/members/$(gh api /user --jq '.login') | head -5
gh api -i /orgs/launchpad-26/members/octocat | head -5   # control: non-member
gh api /rate_limit --jq '.resources.core | {limit,remaining}'
```

No throwaway build was created under `~/rhizomorph-spikes/s5-identity/` — this
lane was entirely read-only `gh api` calls plus documentation lookups, so
there is nothing to run there. The directory exists (created above) but is
empty.
