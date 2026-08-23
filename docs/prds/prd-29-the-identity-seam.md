# prd-29 — the identity seam: a read answers only the token's holder

> **Outcome:** partially shipped — the `gated-read` seam and the first seven SPA reads landed;
> the remaining read-gating policy and external consumers are unresolved. That ruling blocks
> prd-43 issue #23. Reconciled 2026-08-22 at `03df141`; extends prd-23 and stands on
> ADR-0012/0014.

## Problem

Every mutation on this server must prove it holds the capability token. Every read is free — and
the most sensitive bytes the instrument serves sit behind the free half. `GET /api/transcript/:lane`
returns an agent's verbatim conversation, read out of `~/.claude/projects`
(`api/transcript.ts:675`); `/api/stream` and `/api/sessions/:id/events` replay the whole event log —
absolute paths, usernames, pane titles, and, for anything recorded before #292's redaction, the
terminal preview text still on disk. Each of those answers today on exactly one check: a `Host`
header that says loopback (`mutation-guard.ts:185-188`), which any caller writes freely.

The narrowing comes first, because without it this PRD overclaims. ADR-0012 delivers the token
in-band — stamped into every served HTML shell — and `GET /*` must stay tokenless: the browser's
first paint and `rhizomorph rotate`'s own scrape (`cli/rotate.ts:143`) both bootstrap from it. So a
local process that can issue a loopback `GET /` "gets the token exactly as the browser does" —
ADR-0012's consequence, in its own words. **Gating the reads does not stop a local process, and
nothing this PRD ships may say otherwise** — prd-23 ruling 1 narrowed the token's claim once
already, and this document inherits that discipline.

What it buys, honestly: the margins beside the Host law close — a caller that can send but not
read, and the cross-site probe that measures a response it cannot open, now meet a uniform 401
before any handler runs. The "reads are free" assumption is removed from the web's read seams, two
web laws and the SSE transport while they are still cheap to change — that retrofit gets more
expensive every month the SPA grows. And the check itself is the seam stage 2's forwarded-identity
verdict drops into: one place that answers "may this reader read?", today with "it holds the
token", later with a verified identity. That is why this is stage 0 of the ship, not a security
patch.

## Evidence

- **The route table says it plainly** (`api/index.ts:56-87`, seventeen rows): 3 `gated-mutation`,
  3 `ungated-mutation` (the OTLP inbox, prd-23 ruling 6), 11 `read` — the ten `/api` reads plus the
  `GET /*` catch-all — and `read` means no `preHandler` at all. Reads get the loopback `Host` law (#303 made it universal,
  `mutation-guard.ts:185-188`); `Origin` and `Content-Type` stay mutating-only (`:190-199`).
- **prd-23 ruling 5 shipped half-implemented.** `route-class-law.test.ts:61-62` pins the count
  (seventeen, twice, so the walk cannot go vacuous) but never verifies that a `gated-mutation`
  row's route actually carries its gate — the row is prose; nothing today fails if a `preHandler`
  is deleted. `build-app.ts:87` already collects every registered route through an `onRoute` hook,
  so the presence check has somewhere to stand.
- **The token machinery is already whole**: minted once per boot (`api/security.ts:56`,
  `randomBytes(32)` hex), carried as `x-rhizomorph-capability` (`:50`), refusing closed on an empty
  expected token (`:95-100`), applied per-route (`:76-81`) at three call sites (`api/label.ts:38`,
  `api/rotate.ts:40`, `api/lab.ts:671`). `tokensMatch` (`:72`) is a length check plus `===`; its
  own doc (`:64-71`) prices that against three rare mutations, not ten polled reads.
- **Delivery is already whole too**: `server/static.ts` stamps the meta tag into every served
  `.html` (`:49-55`, `:102-109`) behind the `GET /*` catch-all (`:83`, `:86`), and
  `web/src/recordings/capability.ts:29` is the one module that reads it back.
- **Three consumers outside the browser read today, tokenless.** `rhizomorph env` hits
  `GET /api/meta` (`cli/telemetry-env.ts:109`, called from `cli/env.ts:116`) — env failing kills
  lane dispatch; `rhizomorph doctor` probes the same route (`cli/doctor.ts:355`); CI's boot smoke
  curls `/api/meta` (`ci.yml:116`), curls `/` (`:132`), and `cat`s the meta body into the build
  log (`:124`) — the habit prd-23 ruling 1 already put on the record.
- **The stream cannot send a header.** The client is a browser `EventSource`
  (`useEventStream.ts:35`; URL at `App.tsx:59`), which carries cookies but never a custom header,
  and the route's design leans on spec-level `Last-Event-ID` auto-resume (`api/stream.ts:37-42`).
  A route-level `preHandler` still runs before `reply.hijack()` (`:146`), so the gate has a place
  to stand there too.
- **Two web laws currently forbid the fix.** `replay/mutating-calls-law.test.ts:64-77` enumerates
  exactly which modules may send which headers — reads are outside its universe — and
  `drawer/readonly.test.ts:181-186` bans any request init (`method`/`headers`/`credentials`) in
  `drawer/`, where `useTranscript.ts` (`:39`, `:44`, `:49`) fetches the most sensitive route of
  all.

## Success

1. Every `/api` read refuses a tokenless request the way the three mutations already do; `GET /*`
   alone stays tokenless, named as the bootstrap. **Not met while** any `/api` GET answers 2xx
   untokened, or the shell's catch-all grows a gate.
2. "Gated" is proven, not declared. **Not met while** deleting a gated route's `preHandler` leaves
   the suite green.
3. Nothing outside the browser breaks. **Not met while** `rhizomorph env`, `doctor` or `rotate`
   fail against a healthy server, or CI's smoke still writes `/api/meta`'s body into the build log.
4. The stream keeps its nature. **Not met while** `/api/stream` loses `Last-Event-ID` auto-resume,
   any mutation accepts the cookie, or the credential appears in a URL or request line.
5. The prose matches the mechanism. **Not met while** any shipped surface implies read-gating
   stops a local process — ADR-0012's recorded consequence is the ceiling of the claim.

## Non-goals

- **No network exposure of any kind.** Nothing binds beyond loopback; that conversation is "the
  metamorphosis" milestone, gated on rulings nobody has made.
- **Not protection against a local process.** ADR-0012's in-band delivery makes that impossible by
  design; this PRD states it rather than hiding it (see Problem).
- **No auth, no accounts, no identity.** The token names a boot, not a person; stage 2's
  forwarded-identity work gets this seam, not this PRD.
- **Not the app.** The Electron shell (stage 1) changes packaging, not architecture, and stays a
  PRD candidate of its own.

**Rejected alternatives.** *A token file on disk* for the CLI — `cli/rotate.ts:29-40` already
rejected it on the record ("a SECOND copy of the secret, at rest"); ruling 3 keeps that stance.
*A query-param credential* for the stream — it puts the secret in request lines that stage-2
tunnels and proxies log. *Rewriting the stream on fetch-streaming* so it could send a header —
forfeits spec-level auto-resume for the privilege of hand-rolling it. *Gating `GET /*`* — breaks
the browser's bootstrap and rotate's scrape, the two consumers the in-band decision exists for.

## What already exists

The end-state is a promotion of existing organs, not a rewrite. Minting, the header name,
fail-closed empty-token behaviour, per-route gating, in-band delivery, the one web module that
reads the token, the universal Host law, and a route-class law that walks the real running app —
all landed under prd-23 and ADR-0012/0014. This PRD adds one class to a table, one presence check
to an existing hook, one cookie beside an existing meta tag, one shared scrape helper the CLI
already half-owns (`rotate.ts:87`), and header plumbing through read seams the web laws already
know how to police.

## Rulings

Each is a **proposed** verdict with its reasoning; no operator has ruled on any of them.

## Ruling 1 — a fourth route class exists: `gated-read`

All ten `/api` reads take `requireCapabilityToken`; `GET /*` alone keeps class `read`, its row
naming it the bootstrap. ADR-0014 is amended — a new record or an amendment block, never an
in-place edit of accepted prose — for the four-class taxonomy. The amendment names #374 on its way
through: that issue already records ADR-0014-numbered prose promising an exception mechanism no
law implements, and prose that outruns the law is precisely the defect ruling 2 retires for this
table.

## Ruling 2 — the gate-presence law: "gated" fails the build when it is fiction

prd-23 ruling 5's unimplemented half, closed. `build-app.ts:87`'s `onRoute` hook additionally
records each route's `preHandler` chain, and the route-class law fails any `gated-*` row whose
route lacks its gate. Today the table is trusted prose; after this, deleting a gate is a red
build, not a second audit's finding — #234 then #249 was exactly that pair.

## Ruling 3 — the credential stays in-band; the CLI scrapes, it never stores

rotate's recorded rejection of a token file stands. `rhizomorph env` and `rhizomorph doctor` adopt
rotate's existing `GET /` → meta-scrape bootstrap (`rotate.ts:87`, `:143`) through one shared
helper rather than two more copies; CI's boot smoke scrapes the shell first and stops `cat`ing
`/api/meta` into the build log. One extra request per CLI invocation is the recorded price.

## Ruling 4 — the stream authenticates by cookie, never by query param

`EventSource` cannot set a header, so the HTML serve that already stamps the meta tag also sets an
HttpOnly, SameSite=Strict cookie carrying the token. It is accepted as an alternate credential on
`gated-read` routes ONLY — a mutation never honours it, because an ambient credential on a
mutation is CSRF re-invented. Spec-level `Last-Event-ID` auto-resume survives untouched, and the
client does not change at all (`useEventStream.ts` — the cookie rides automatically). The query
param and the fetch-streaming rewrite are rejected above.

## Ruling 5 — `tokensMatch` becomes constant-time

`api/security.ts:72` upgrades from length-checked `===` to `timingSafeEqual`. The existing doc's
trade-off was priced against three rare, human-initiated mutations; ten reads polled continuously
by the dashboard is a different probe profile, and the fix is a few lines in one file.

## Ruling 6 — the web laws grow a read axis; nothing is slipped past them

`mutating-calls-law.test.ts`'s discipline — inline literal headers, names imported from the one
capability module — extends to a `READ_MODULES` enumeration rather than being loosened.
`drawer/readonly.test.ts`'s "no request init at all" is amended **by argument, here**: its doc
calls the drawer's read-only nature constitutional, and the constitution forbids mutations, not
credentials — a header proving the reader may read mutates nothing. The amendment lands as a
tightening (an allowed-headers literal), never as `Record<string, string>`.

## Sequencing (waves, each gated as ever)

Route math, so no wave is vague: of the ten `/api` reads, seven gate in wave 1 (`/api/sessions`,
`/api/sessions/:id/events`, `/api/transcript/:lane`, `/api/lanes`, `/api/lab/checkpoints`,
`/api/lab/experiments`, `/api/lab/estimate`), two in wave 2a (`/api/meta`, `/api/doctor`), one in
wave 2b (`/api/stream`); `GET /*` stays `read` forever.

1. **Keystone — the seam exists:** the `gated-read` class and its ADR amendment; the gate-presence
   law; `timingSafeEqual`; the seven SPA-only reads gated; header plumbing through their web seams
   via one shared capability-read module; both web-law amendments. Excludes `/api/meta`,
   `/api/doctor` and `/api/stream` so no consumer outside the SPA breaks mid-milestone.
2. **Fenced apart, parallel:** (a) `/api/meta` and `/api/doctor` gated, the shared CLI scrape
   helper adopted by `env`/`doctor`, CI's smoke rewritten to scrape the shell first · (b) the
   cookie and `/api/stream` gated, client untouched.
3. **Gated on #428 landing:** read-route contract tests — `packages/contract/`'s coverage law
   grows the read axis (its parser is mutations-only by its own PR's account).

## Open questions

- **Dev mode, inherited from prd-23 and still open.** `vite dev` serves `index.html` itself, so
  neither meta tag nor cookie exists there — ADR-0012 records that `dev:web` alone reaches no live
  server anyway; the gate adds refusal to unreachability. Dev-only token, proxy, or honest refusal
  — whoever rules prd-23's copy of this question rules this one.
- **Does the cookie rotate?** `/api/rotate` mints a new session id and the token does not move
  (prd-23's open question); a cookie copy of the token inherits that question exactly.
- **Amendment or new ADR** for the four-class table — the leads own the form, as they did for
  ADR-0012 against ADR-0008.
- **Wave 3's shape** — whether the read axis extends the existing coverage law's parser or gets
  its own walker is decided after #428 lands, not here.
