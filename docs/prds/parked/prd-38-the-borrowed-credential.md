# prd-38 — the borrowed credential

> **Status:** parked — proposed future direction, zero of five Success criteria implemented and
> self-gated on an ADR that does not exist. Moving back into flight requires renewed operator
> blessing. Reconciled 2026-08-22 at `03df141`.
>
> **Owner:** operator · **Depends on:** prd-20 (the concierge), prd-23 (the trust boundary),
> prd-34 (the doorstep), ADR-0019 (the fourth hand), ADR-0024 (the gated read)

## Problem

The repo picker can only offer what is already on disk. That answers the wrong
question: a stranger at prd-34's doorstep is not wondering which directories
this machine has — they are wondering **"which of MY repos can this watch?"**,
and the answer lives on the forge. Today the picker's evidence for "your
repos" is Claude's own history of working directories, and the audit that
prompted this PRD measured how bad that evidence is: 301 history slugs on one
machine, 289 of them worktree lanes whose directories no longer exist, three
of the resolvable remainder not git repos at all. The local-history half is
being fixed by filtering (the picker now offers only real repos), but a
filtered wrong answer is still the wrong answer to the stranger's question.

Clone-by-URL, the recorded remedy for "a repo living somewhere
unconventional" (prd-20 ruling 5), makes the stranger leave the instrument,
find a URL by hand, and paste it. And a private HTTPS clone silently depends
on the machine's git credentials being configured — a dependency that is
invisible until it fails, which is the shape of dishonesty this repo's
capability-manifest culture (prd-15 ruling 5) exists to prevent.

## Evidence

- The measured garbage rate above (2026-08-20 audit, this machine).
- prd-34 success 1: a stranger, under N minutes, no AGENTS.md open. The repo
  step is the first place that clock actually spends time.
- `docs/research/2026-08-13-from-localhost-to-true-software.md` stages the
  online future on **borrowed identity** (Tailscale `whois`, Cloudflare
  Access JWT, OIDC): "No hand-rolled accounts, ever"; "Two credential planes,
  never one."
- prd-20's own non-goal text names the blessed machinery: "Clone-by-URL uses
  the machine's existing git/**gh** credentials." The CLI is already inside
  the trust story; only the *listing* surface is new.

## Success

1. With `gh` logged in, the repo step offers "your GitHub repos" — name,
   visibility, last-updated — and choosing a private one clones without any
   credential appearing in argv, env, the record, or a log (law-tested).
2. Without `gh` (absent or logged out), exactly one reason/remedy line
   appears ("install GitHub CLI; run `gh auth login`") and nothing else
   degrades.
3. The browser-only SPA has full parity — the delegation is server-side.
4. The route sits in ADR-0024's `gated-read` class, proven by the
   route-class law.
5. The paper lands before the code: this PRD and its ADR merge first.

## Non-goals

- **No rhizomorph accounts.** Unchanged, permanent.
- **No server-held or SPA-held tokens.** The web mutating-calls law (five
  modules, exact headers) is not amended by this PRD.
- **No cloud relay, no TLS change, no remote access.** prd-23's boundary
  stands.
- **No write scopes.** Listing and cloning; never push, never PRs.
- **Not the shared-world identity plane.** prd-37 ruling 2 (git identity +
  one-time local declaration) is untouched — see ruling 9.
- **No other forges at stage 1.** GitHub is where the cohort's repos are;
  GitLab/Gitea are a later ruling with the same shape.
- **Nothing acquired or sent without an explicit click.** Discovery reads;
  it never mutates, never phones home on a timer.

## Rulings

### Ruling 1 — stage 1 delegates to `gh` and holds nothing

The server spawns `gh auth status` (detection) and
`gh repo list --json nameWithOwner,visibility,updatedAt` (the listing) as
argv arrays with no shell, the same spawn discipline the concierge namespace
law already polices, and serves the parsed fruit at
`GET /api/concierge/github/repos`. The token never exists anywhere rhizomorph
owns: it lives in gh's own store, put there by the operator's own
`gh auth login` — the same machine credential prd-20's non-goal already
blesses by name for clone. ADR-0019's grant 5 ("it holds no secret") stays
literally true.

Private clone needs no new machinery: `gh auth login` installs gh as a git
credential helper, so the existing clone route's plain
`git clone https://github.com/o/r.git` authenticates with no URL-embedded
credential. `EMBEDDED_CREDENTIAL_RE` and `HTTP_USERINFO_RE` stand unamended.

### Ruling 2 — the listing is a gated read, never tokenless

"My GitHub repos" is account-shaped data, not machine shape. The route takes
the capability token (ADR-0024's `gated-read` class — built for exactly this
distinction) even though the local `/api/concierge/repos` stays tokenless.

### Ruling 3 — in-app OAuth is stage 2, lives in the shell, and waits for measured need

If the cohort's measured gh-install rate ever makes stage 1 insufficient, the
fallback is GitHub's **device flow** (RFC 8628 — client_id only, no
embeddable secret, no loopback redirect server), run by `packages/app`, with
the token in Electron `safeStorage` and only its *fruit* crossing the
three-call bridge. That amends prd-34 ruling 1 ("adds no credential
machinery") explicitly, in its own ADR, before any code. The loopback web
flow is rejected now (GitHub's OAuth-app token exchange wants a client
secret; a secret in a shipped binary is public). Writing into gh's own store
is rejected now (not a public API).

### Ruling 4 — where the token never lives

Never the server process. Never the SPA. Never the app's plain-JSON userData
files (a token may not join `prefs.json`). Never argv, never a child's env,
never the hash-chained record, never a log line. Stage 1 makes this
structural: the only token on the machine is gh's, placed by the operator's
own act. A fixture gh that emits a fake token, with a law asserting it never
reaches the record or a log, is part of stage 1's acceptance.

### Ruling 5 — what the credential is for

Two acts, both explicit: populating the picker, and cloning a chosen repo via
the credential-helper handoff. The second is ruled here so the argv-credential
refusal reads as load-bearing design rather than accident.

### Ruling 6 — parity for the browser-only SPA

Full. The delegation is server-side; a browser tab gets the same listing
through the same gated read with the capability token it already holds
(ADR-0012). The SPA never receives the GitHub token under any stage.

### Ruling 7 — revocation is GitHub's, honesty is ours

Stage 1: the instrument surfaces `gh auth status` and manages nothing —
logout is `gh auth logout`, said in words, not offered as a button. Stage 2
(if ever): the shell's "forget" deletes from safeStorage and links GitHub's
own revocation settings; deletion is local, revocation is GitHub's, and the
UI says which is which.

### Ruling 8 — scope minimisation

Stage 1 inherits whatever the operator granted gh, and the UI says so ("as
your gh login"). Stage 2 must choose before it ships: a GitHub App with
fine-grained `metadata:read` + `contents:read` is preferred; classic `repo`
scope (the only classic scope that reads private repos) grants write and is
refused unless the operator explicitly opts into private listing with that
cost stated.

### Ruling 9 — a GitHub login is not a rhizomorph identity

prd-37 ruling 2 stands: identity in the shared world is git identity plus a
one-time local declaration. What this PRD adds is *the same borrowed-identity
family* the staged-ship research already chose for the online stages — so if
stage 2 of the shared world ever verifies forwarded identity, a GitHub-backed
OIDC assertion slots into the seam prd-29 built, and nothing here has to be
undone. Groundwork, not a account system.

### Ruling 10 — what the server sees

gh's stdout and exit code, parsed and served, never persisted. No new
data-at-rest class exists. The listing response is not written to the record;
a replay of a session does not contain another person's repo list.

## Supersessions (paper before code)

- **prd-20 non-goal** — amended narrowly by this PRD, never edited in place:
  "no stored credentials" stands; "no OAuth" is restated as "no OAuth in the
  server or the SPA; gh delegation (blessed by this non-goal's own text) may
  feed the picker; in-shell device flow is ruling 3's separate, staged
  decision."
- **ADR-0019 option E** — stays rejected for the fourth hand. An appended
  ADR records that *listing* borrows the same machine credential *clone*
  always borrowed (the hand still holds nothing), and that any stage-2 holder
  is the shell — a different trust domain requiring its own ADR first.
- **prd-23** — boundary note only: unchanged for web and server; the gated
  read is ADR-0024 doing the job it was built for.
- **prd-34 rulings 1 and 4** — kept true verbatim at stage 1; ruling 3 here
  names the amendment stage 2 would require.

## Open questions

- The cohort's actual gh-install rate (decides whether stage 2 is ever worth
  its ADR).
- Who owns the GitHub App / client_id registration if stage 2 ships — a
  GitHub-side artifact someone must hold, which sits awkwardly beside "no
  cloud"; named here rather than discovered later.
- Whether the picker should distinguish "yours" from "org repos you can
  read" — a taxonomy question for the wizard's copy, not a security one.
