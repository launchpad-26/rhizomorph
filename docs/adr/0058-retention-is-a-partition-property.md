# ADR-0058 — retention is a property of the partition, decided from the most generous ceiling

**Status:** accepted (prd-51 wave 12, #559)

## Context and Problem Statement

prd-51 rulings 9 and 10 give the organisation's admin a retention ceiling: raw events past a named
age are dropped, the decision is *"made once at ceiling time, never silently"*, and every effective
value names who set it and where — including where the setter is a default.

The shape of the schema decides how that can be implemented. `0001_events.sql` partitions `events`
by `ts` and by nothing else: one partition per month, holding every project's rows together. There
is no per-project partition and adding one is not available — an applied migration is never edited,
and `0001`'s header records that the single legal retroactive edit has been spent.

So a ceiling is named per project, and the unit that can actually be dropped is a partition
holding several projects. Those two facts do not line up, and something has to give.

## Considered Options

1. **Per-project `DELETE` within a shared partition** — keep the partition, delete the rows whose
   project is past its own ceiling.
2. **Re-partition by `(project_id, ts)`** so a project's rows can be dropped independently.
3. **A per-partition verdict taken from the most generous ceiling that applies to it** — drop the
   whole partition only when every project sharing it is past its own ceiling.
4. **A route on the viewer** for naming the ceiling, rather than a host command.

## Decision Outcome

**Option 3**, with option 4 rejected separately for the naming surface (ruling B already settles
that: the ceiling is named by a command in the deployment directory, not by a route).

**Option 1 loses on what ruling 10 measured.** A `DELETE` across a shared partition is the
17.6-second, two-lock-window path that ruling exists to avoid — it takes locks on the hot ingest
table for the duration, and the fold is writing to the same partition.

**Option 2 loses because it is a rewrite of `0001`.** Re-partitioning is not a migration you add;
it is a migration you replace, and `0001` is applied everywhere this has ever run.

**Option 3's cost is real and is the reason the MAXIMUM is taken rather than the minimum.** If the
verdict took the strictest ceiling, a single project naming a one-day ceiling would drop every
other project's rows in that month. Taking the most generous inverts that: a partition survives
until every project sharing it is past its own ceiling, so the error is always in the direction of
keeping data.

## Consequences

- **A project with no ceiling at all can lose rows to another project's ceiling.** This is the bad
  consequence and it is not hypothetical — it was reproduced against PostgreSQL 18.4 during
  verification: naming a one-day ceiling for `proj-b` dropped `proj-a`'s only row, and `proj-a` had
  never named a ceiling. It follows directly from the partition being shared and is not a defect in
  the implementation.

  It is stated out loud in the two places an operator can meet it: the host command prints the
  shared-partition consequence at ceiling-naming time, which is ruling 10's *"made once at ceiling
  time, never silently"* doing its work, and `planRetention` carries it in every verdict's reason.
  **A log line is not consent, so the printing happens before the ceiling is accepted rather than
  after it is applied.**

- **The drop is coarse.** Rows younger than a project's own ceiling are kept when they share a
  partition with rows that are not. That is the direction of keeping data, and it means the
  ceiling is a bound on age rather than a guarantee of deletion — anyone reading it as a privacy
  control is reading it wrong, and the command's own text says so.

- **This closes when the partitioning changes and not before.** The honest fix is option 2, in a
  programme that can afford to rewrite `0001`. Until then, a deployment that needs per-project
  retention needs a deployment per project.

- **The naming surface is a host command, so there is no viewer page to authorise.** That is ruling
  B's decision rather than this one's, but it is why nothing here touches the route table: an admin
  act on the host is also the honest reading of *"made once at ceiling time"*.
