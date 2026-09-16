# ADR-0057 — the viewer reads as `rz_viewer` by SET LOCAL ROLE, not as a second authenticated connection

**Status:** accepted (prd-51 wave 11, #557)

## Context and Problem Statement

`migrations/0003_roles_rls.sql` puts row-level security on the four fact tables and records the
measurement that makes one deployment fact load-bearing:

> plain owner, FORCE ON → sees none; plain owner, FORCE off → sees every project's rows

and then, in its own words, that **a superuser bypasses RLS unconditionally and nothing in SQL
closes it**, so:

> the isolation guarantee therefore rests on a deployment fact this migration cannot enforce:
> wave 3 reads as `rz_viewer` or `rz_readonly`, never as the owner and never as a superuser.

#557 is the first reader to need that fact to be true. Planning found it **unbuildable as
groomed**: all three `rz_` roles are `NOLOGIN`, no tracked migration grants LOGIN or sets a
password, and no role-membership grant existed either — so there was neither a credential to
connect with nor a legal `SET ROLE` to reach. The issue's Definition of done had assumed a second
DSN and an `init.sh`-minted password for a role that cannot log in.

## Considered Options

1. **Membership plus `SET LOCAL ROLE`** — one GRANT in a new migration; the app keeps its single
   connection and each read runs in a transaction that becomes `rz_viewer` for its duration.
2. **Give `rz_viewer` LOGIN and a password** — a second DSN, minted by `init.sh`, passed by
   `compose.yml`, held as a new `TeamConfig` value.
3. **Rely on the app being the instance superuser**, which may `SET ROLE` to anything with no
   membership at all — no migration, works today.

## Decision Outcome

**Option 1**, ruled by the operator in session on 2026-09-16.
`0006_viewer_role_membership.sql` is `GRANT rz_viewer TO CURRENT_USER WITH INHERIT FALSE;` — the
`WITH INHERIT FALSE` is not incidental, and the Consequences below record what a plain grant did —
and the adapter at
`storage/ports/questions/sql.ts` opens every read with `set local role rz_viewer`.

**Option 2 loses on cost for no isolation.** A LOGIN role means a second secret in `.env`, a
second connection pool, and a second thing to rotate — and it buys nothing the SET ROLE does not
already give, because the isolation comes from *which role the statement runs as*, not from how
that role was reached.

**Option 3 loses because it fails open, silently, and later.** It works only while the app is
superuser — which is exactly the property `0003`'s header says isolation must not rest on. The day
anyone narrows the app's role, `SET ROLE` starts failing; and any handling that treats that as
recoverable yields a viewer reading every project. The failure is invisible to every functional
test, because a viewer that reads as the owner returns **more** rows, not fewer.

`SET LOCAL` rather than `SET`: it reverts at COMMIT, so the role cannot outlive its transaction on
a pooled connection — in either direction. A leaked `rz_viewer` costs a later writer its rights;
a connection that failed to reset hands the next viewer the owner's.

## Consequences

- **CURRENT_USER, so the schema does not name one deployment's owner.** `deploy/init.sh` sets
  POSTGRES_USER and an operator may change it; the migration is applied by that owner.
- **The project scope is a second required statement, and forgetting it fails the other way.**
  Every policy reads `current_setting('rhizomorph.project_id', true)`, so each read also issues
  `select set_config('rhizomorph.project_id', $1, true)` — parameterised, because the statement
  form cannot bind. Without the role the viewer reads everything; without the setting it reads
  **nothing**, and a permanently empty page looks like a fold problem rather than a scope one.
  Both are asserted on the statement tape, not on rows.
- **The grant must carry `WITH INHERIT FALSE`, and the first draft did not.** RLS matches a
  policy's `TO` list by role **membership**, so a plain `GRANT rz_viewer TO CURRENT_USER` makes
  the owner pass `FOR SELECT TO rz_viewer` policies *with no SET ROLE at all* — silently widening
  the plain-owner case `0003`'s header measured as closed, and quietly undermining the mutation
  that proves this decision (delete the SET ROLE and the owner reads every project anyway).
  Verification caught it; EXECUTED on PostgreSQL 18.4, owner creating the role as `0003` does:

  | | owner, no SET ROLE | owner, SET ROLE |
  |---|---|---|
  | before the grant | 0 | **permission denied** |
  | plain `GRANT` | **1** | 1 |
  | `GRANT … WITH INHERIT FALSE` | 0 | 1 |

  The bottom row is what ships. The middle row is the widening. The top row's refusal is also
  why this migration exists at all: a role cannot be assumed by someone who is not a member.

- **This does not make the superuser case safe.** A superuser that has *not* done SET ROLE
  bypasses RLS whatever its memberships, exactly as `0003` says. The grant only removes the
  accidental dependency on the app *being* one.

- **The project scope is not an authorisation boundary, and the first draft's docblock said it
  was.** The adapter sets `rhizomorph.project_id` from the caller's own `?project=`, and the
  policies read that setting — so the pair buys a query that cannot leak another project through
  a forgotten `WHERE`, and buys the owner's rights being dropped, but it does **not** stop one
  member reading another project. Verification measured the unnarrowed version returning the
  other project's rows on a real engine. **Membership of the organisation is the boundary**
  (#169), which is prd-51's premise; `RZ_TEAM_PROJECT` narrows a single-project deployment to its
  own, and where that is unset any member may name any project. Per-project authorisation would
  need a per-project membership model this deployment does not have — that is a PRD's decision,
  not a lane's.
- **The migration id moved for a later wave.** prd-51 groomed retention (#559, wave 12) as
  "the next migration", which was `0006`; it is now `0007`, and the migration-count pins in
  `bootstrap.test.ts`, `migrations/runner.test.ts` and `migrations/schema-law.test.ts` will already
  stand at 6.
- **A restored database still diverges silently**, and this migration is where it now surfaces:
  #514 measured a host whose `_migrations` recorded `0003` as applied while its roles were absent.
  `0006` raises a named exception in that state instead of `role "rz_viewer" does not exist`.
