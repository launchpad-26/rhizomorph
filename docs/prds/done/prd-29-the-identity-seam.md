# prd-29 — the identity seam: a read answers only the token's holder

> **Status:** **SHIPPED** — 2026-09-02. Milestone `prd29`: four issues, all closed; the closeout,
> including what the plan got wrong, is the last section of this document. All fourteen `/api`
> reads are `gated-read`; `GET /*` alone stays tokenless, forever, as the named bootstrap.
>
> **Outcome (as ruled, 2026-08-24):** all six rulings accepted and ruling 7 gates the four reads
> that postdated the route math; wave 1 shipped; waves 2a/2b and the four-read slice are
> groomable. Unblocks prd-43 issue #23. Reconciled 2026-08-22 at `03df141`; extends prd-23 and
> stands on ADR-0012/0014/0024.

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

Rulings 1–6 below were written as proposals; the operator ruled them accepted 2026-08-24, and
ruling 7 was added by the same act — see the amendment at the foot of this document.

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

## Amendment — the seam is ruled (operator, 2026-08-24)

The six rulings stop being proposals. Rulings 1, 2 and 5 were already fact in the tree when
the operator ruled — ADR-0024 carries the `gated-read` class and the gate-presence law, and
`tokensMatch` is `timingSafeEqual` (`api/security.ts:72`) — so accepting them records what the
build already enforces. Rulings 3, 4 and 6 are confirmed as written: wave 2a (the shared CLI
scrape helper; CI's smoke stops `cat`ing `/api/meta` into the build log) and wave 2b (the
HttpOnly SameSite=Strict cookie, honoured on `gated-read` routes only, never a mutation) may
be groomed.

### Ruling 7 — the four reads that postdate the route math gate too

The Sequencing arithmetic ("of the ten `/api` reads") predates four reads:
`GET /api/lane-index` and `GET /api/lane-index/:handle` (prd-31 ruling 5, #556),
`GET /api/session-preview/:sessionId` (prd20 w6, #516), and `GET /api/concierge/repos`
(prd-20 ruling 5 / ADR-0019). All four join `gated-read`. Every consumer is the SPA
(`lane-page/laneIndex.ts`, `recordings/laneIndex.ts`, `connect/meta.ts`), which already holds
the one capability-read module, so nothing outside the browser breaks — and `session-preview`
returns transcript content, the family wave 1 gated first. `session-preview.ts`'s recorded
#216 posture ("untokened, like `/api/doctor`") predates the `gated-read` class and is
superseded by this ruling.

Route math, corrected: fourteen `/api` reads today, not ten — seven gated in wave 1, three
deferred to wave 2, four gated by this ruling (one wave-1-shaped slice, groomable beside
wave 2a). End-state unchanged in spirit and now total in letter: after the waves land,
"permanently tokenless" names exactly one read — `GET /*` — plus the OTLP inbox's four
ungated mutations. That is the sentence prd-43 issue #23 was blocked on, and ADR-0012's
ceiling still applies: none of this stops a local process, and no shipped surface may say
otherwise.

## The three wave-less rows, declared

Amended 2026-09-02. `scripts/dev/prd-reconcile.sh 29` reports **NO WAVE** for `#58`, `#59` and
`#60`. None of the three was unsequenced: they carry `w1b:`, `w2a:` and `w2b:` in their titles,
which is exactly the sub-wave vocabulary the Sequencing section above uses (*"two in wave 2a
(`/api/meta`, `/api/doctor`), one in wave 2b (`/api/stream`)"*). The check wants an integer — a
`wN:` token — and a lettered sub-wave does not match it, so fence-lint never saw the three and the
board's orphan check could not tell.

**The document is right and the tooling is right; the vocabularies simply disagree.** Sub-waves
were the honest description here: wave 2's two halves genuinely could run in parallel and
genuinely had different blast radii — 2a breaks CLI consumers if it is wrong, 2b breaks the
browser's stream — so splitting them by letter recorded a real distinction that "wave 2" and
"wave 3" would have flattened. Every later PRD in this cohort uses integers only, and none has
needed a letter since.

**This paragraph does not clear the rows, and is not meant to.** The check reads the issue title
and never reads this document, so all three report for as long as they keep their titles. Retitling
three closed issues would falsify the record of what was actually dispatched, which wave 6 of
prd-46 and the `#75` paragraph there both refuse on the same ground. Standing report, reason
recorded.

## The seven rulings, as they landed

**Ruling 1 — a fourth route class exists: `gated-read`.** Landed, and it is now the largest class
in the table: `api/index.ts` carries **fourteen** `gated-read` rows and exactly one `read` —
`GET /*`, the named bootstrap, with the OTLP inbox's four rows the only `ungated-mutation`s.
ADR-0024 carries the four-class taxonomy, by amendment rather than in-place edit as the ruling
required.

**Ruling 2 — the gate-presence law: "gated" fails the build when it is fiction.** Landed. prd-23
ruling 5's unimplemented half is closed: the route-class law reads each route's real `preHandler`
chain off `build-app.ts`'s `onRoute` hook and fails any `gated-*` row whose route lacks its gate
(`route-class-law.test.ts:141`). The table stopped being trusted prose.

**Ruling 3 — the credential stays in-band; the CLI scrapes, it never stores.** Landed in wave 2a
(`#59`). `rhizomorph env` and `doctor` adopted rotate's existing meta-scrape through one shared
helper rather than growing two more copies, and CI's boot smoke now scrapes the shell for the
token and sends it (`ci.yml:161`) instead of `cat`ing `/api/meta`'s body into the build log. The
recorded price — one extra request per CLI invocation — was paid as stated.

**Ruling 4 — the stream authenticates by cookie, never by query param.** Landed in wave 2b
(`#60`). `CAPABILITY_COOKIE_NAME`, HttpOnly and SameSite=Strict, set beside the meta tag by the
same HTML serve (`api/security.ts:96`), read back only when a gate is built with `allowCookie`.
`No Secure` is a deliberate, documented choice — the server is loopback-only over plain HTTP, and
a `Secure` cookie would silently never be sent. The client did not change at all, and
`Last-Event-ID` auto-resume survived untouched, both as the ruling promised. See the residuals
for the half of this ruling that is enforced by omission rather than by a law.

**Ruling 5 — `tokensMatch` becomes constant-time.** Landed; `timingSafeEqual` at
`api/security.ts`. It was already fact in the tree when the operator ruled, so accepting it
recorded what the build enforced.

**Ruling 6 — the web laws grow a read axis; nothing is slipped past them.** Landed. Both laws were
amended as *tightenings* rather than loosenings — `mutating-calls-law.test.ts` grew a read
enumeration instead of dropping its universe, and `drawer/readonly.test.ts`'s "no request init at
all" became an allowed-headers literal rather than `Record<string, string>`. The argument the
ruling made for the drawer amendment is the one that held: the constitution forbids mutations, not
credentials, and a header proving the reader may read mutates nothing.

**Ruling 7 — the four reads that postdate the route math gate too.** Landed (`#58`). This is the
ruling worth reading, because it exists only because somebody re-derived an arithmetic the
document had already stated. The Sequencing said *"of the ten `/api` reads"*; there were fourteen,
four having arrived from prd-31, prd-20 and ADR-0019 after the math was written. One of them,
`GET /api/session-preview/:sessionId`, returns transcript content — the family wave 1 gated first
— and carried a recorded `#216` posture (*"untokened, like `/api/doctor`"*) that predated the
class entirely.

## The five success criteria, assessed

1. **Every `/api` read refuses a tokenless request; `GET /*` alone stays tokenless — MET.**
   Fourteen `gated-read` rows, one `read` row, and the catch-all never grew a gate.
2. **"Gated" is proven, not declared — MET.** Ruling 2's presence check reads the running app's
   real `preHandler` chains rather than the table's prose.
3. **Nothing outside the browser breaks — MET.** The shared scrape helper carried `env`, `doctor`
   and `rotate`; CI's smoke sends the token and no longer prints the meta body.
4. **The stream keeps its nature — MET as written, and see the residual.** `Last-Event-ID`
   survives, the credential appears in no URL or request line, and no mutation *does* accept the
   cookie today. The clause *"any mutation accepts the cookie"* is a falsifier no law watches.
5. **The prose matches the mechanism — MET.** The ceiling ADR-0012 records is stated in the
   Problem, restated as a non-goal, and restated again in ruling 7's last sentence. Nothing
   shipped claims read-gating stops a local process, which for a security-shaped PRD is the
   criterion most worth having written down.

`EXECUTED` 2026-09-02, Node v22.23.2: `route-class-law`, `api/security`,
`replay/mutating-calls-law` and `drawer/readonly` — 4 files, **61 passed**.

## The four open questions, answered

**Dev mode, inherited from prd-23.** **Still open, still inherited.** `vite dev` serves
`index.html` itself, so neither meta tag nor cookie exists there; ADR-0012 records that `dev:web`
alone reaches no live server anyway, so the gate adds refusal to unreachability. Whoever rules
prd-23's copy rules this one. Nothing here resolved it.

**Does the cookie rotate?** **Still open**, and now with a second holder: `/api/rotate` mints a
new session id and the token does not move, so a cookie copy of the token inherits prd-23's
question exactly. Unchanged by anything this PRD shipped.

**Amendment or new ADR for the four-class table?** **Answered: a new record.** ADR-0024 carries
the `gated-read` class and the gate-presence law. The leads owned the form and took it.

**Wave 3's shape — extend the coverage law's parser, or a new walker?** **Answered by wave 3
itself** (`#61`): the read axis joined `packages/contract/`'s existing coverage law rather than
getting its own walker.

## What the plan got wrong

**The route arithmetic went stale between drafting and grooming, and the document had no way to
notice.** *"Of the ten `/api` reads"* was true when written and wrong by the time waves were
groomed — four reads had arrived from three other PRDs. Ruling 7 caught it, but only because a
human re-counted; nothing in the tooling compares a PRD's stated route math against the route
table it describes. The gate-presence law this very PRD built proves a row's gate exists; no law
proves the *document's* count of rows is current. That is the same class of defect one level up,
and it is the most interesting thing prd-29 produced.

**A lettered sub-wave is a vocabulary the tooling does not speak.** `w1b`, `w2a` and `w2b` were
honest descriptions of real parallelism with different blast radii, and they cost three permanent
NO WAVE rows. The distinction was worth recording; the notation was not the way to record it.

**Ruling 4's "a mutation never honours the cookie" is enforced by omission.** The ruling states it
as an absolute, `api/security.ts:144-153` says plainly that it is *"enforced by omission, not a
runtime check"*, and `security.test.ts` asserts the refusal against the gate's default rather than
against the wiring. That is a check proving a proxy for the fact it claims — prd-45 ruling 2's
exact subject, in a PRD that shipped the week before prd-45 was blessed. See the residual for the
mutation that proves it.

**The status block said "waves 2a/2b and the four-read slice are groomable" and then stayed that
way after they shipped.** All four issues closed 2026-08-25; the document read as mid-flight until
today. Same drift prd-45 recorded about itself, from the same cause — nobody was reading prd-29
any more.

## Residuals, with owners

- **No law stops a `gated-mutation` route from being built with `allowCookie: true`.** Ruling 4
  forbids it in words; the enforcement is that every mutation call site happens to omit the
  option. **`EXECUTED` 2026-09-02 — the mutation is silent.** Adding `{ allowCookie: true }` to
  `POST /api/label`'s gate (`api/label.ts:38`) and running `route-class-law`, `api/security` and
  `api/label` gives **47 passed, nothing red**: the route-class law sees a gate is present, not
  which options built it, and the security test asserts the default rather than the wiring.
  Reverted immediately; the file is unchanged. The practical exposure is bounded by
  SameSite=Strict, so this is a missing law rather than a live hole — but it is exactly the shape
  prd-45 and prd-46 spent two milestones closing in `gate.sh`. **No owner.**
- **The document's route count has no law.** Ruling 7 exists because the arithmetic went stale and
  a person noticed. Nothing compares a PRD's stated route math to `api/index.ts`'s table, and the
  next PRD that quotes a count will go stale the same way. **No owner.**
- **Dev mode.** Open question 1, inherited from prd-23 and still held there. **Owned by a PRD, not
  by an issue.**
- **Whether the cookie rotates.** Open question 2, inherited from prd-23's identical question
  about the token. **Owned by a PRD, not by an issue.**
- **Stage 2's forwarded identity.** The whole point of building the seam — *"one place that
  answers 'may this reader read?', today with 'it holds the token', later with a verified
  identity"*. The seam exists and is unoccupied. Explicitly a non-goal here; no successor PRD has
  claimed it. **No owner.**
