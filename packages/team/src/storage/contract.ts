import type { EventsPort } from './ports/events/port.js'
import type { IngestKeysPort } from './ports/ingest-keys/port.js'
import type { LifecyclePort } from './ports/lifecycle/port.js'
import type { MigrationsPort } from './ports/migrations/port.js'
import type { QuestionsPort } from './ports/questions/port.js'
import type { RetentionPort } from './ports/retention/port.js'
import type { SettingsPort } from './ports/settings/port.js'

/**
 * THE STORAGE PORT (prd-51 ruling 5).
 *
 * Ruling 5 puts the team server's storage on Postgres and keeps one discipline
 * from the SQLite-first design it deviates from: **storage behind an interface,
 * no SQL in route handlers** — so the engine stays a re-deployment rather than a
 * rewrite. This module is that interface.
 *
 * Three things it deliberately is NOT:
 *
 * - **It is not a driver.** Nothing here imports `postgres`, names a driver
 *   type, or returns one. `no-sql-outside-storage-law.test.ts` holds that as a
 *   grep law over this package's sources.
 * - **It is not a query.** No method takes or returns a SQL string, a fragment,
 *   or a builder. Everything crossing this boundary is plain data.
 * - **It is not the ingest route.** Ruling 4's ordering — journal, then
 *   `BEGIN` → insert → `COMMIT`, and only *then* the cursor — is a constraint on
 *   the caller. The port only has to make "one transaction that either wrote the
 *   batch or wrote nothing" expressible, which is what {@link EventsPort.appendEvents}
 *   is. When it is called, and what happens either side of it, is the ingest
 *   issue's (wave 3).
 *
 * There is no `node:*` here either, and no dependency at all.
 *
 * ## What it now IS: the intersection, and the re-export surface
 *
 * A storage capability is a **port** — one directory under `ports/` holding its
 * interface, its fake and its SQL. {@link TeamStorage} is the intersection of
 * those interfaces and holds no methods of its own, so a wave that adds a
 * capability adds a directory and one line here, and edits no other port's
 * files. This module re-exports every type the ports own, at the names they
 * have always had, so all 21 importers of `storage/contract.js` compile
 * untouched.
 */

/**
 * A value the server will later report as effective (ruling 9).
 *
 * Every configured value names who set it and where, **even where the only
 * setter today is a default** — that is the whole of ruling 9. A default whose
 * provenance is "it is just the default" is the one an operator cannot find.
 *
 * Declared here and owned by no port: it is `config/config.ts`'s type and only
 * has a home in this package's storage module for historical reasons.
 */
export interface EffectiveValue<T> {
  /** The field's own name, as a report would print it. */
  readonly name: string
  readonly value: T
  readonly setBy: 'default' | 'environment'
  /** WHERE it was set: a tracked path for a default, an env var name for an override. */
  readonly source: string
  /** What a report may print. Never a secret. */
  readonly display: string
}

/** The refusal shape this package uses, following `parseIngestRequest` in core's wire. */
export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: string }

// The port surfaces, re-exported at the names every consumer already imports.
// Alphabetical, one port per line: a wave-9 lane adds one line here and a
// cherry-pick collision is a both-sides-add resolved mechanically.
export type {
  CollisionDelta,
  EventQuery,
  EventRow,
  EventsPort,
  LaneStateDelta,
  ProjectionDelta,
  SpendDelta,
} from './ports/events/port.js'
export type { IngestKeyRow, IngestKeysPort } from './ports/ingest-keys/port.js'
export type { LifecyclePort } from './ports/lifecycle/port.js'
export type { AppliedMigration, MigrationsPort } from './ports/migrations/port.js'
export type { CollisionRow, LaneRow, QuestionsPort, SpendRow } from './ports/questions/port.js'
export {
  NO_CEILING_SOURCE,
  RETENTION_QUOTA_GAP,
  type RetentionCeiling,
  type RetentionPort,
} from './ports/retention/port.js'
export type { SettingsPort } from './ports/settings/port.js'

/**
 * Everything the server can ask a database. No SQL crosses this boundary —
 * not as a string, not as a fragment, not as an object.
 *
 * A type **alias** rather than an `interface … extends`, because the claim is
 * that `TeamStorage` *is* the intersection of its ports rather than a thing
 * that happens to have them. Drop a port from this line and `tsc` fails in
 * whichever consumer used its methods — which is the compile-time proof that
 * the intersection is what consumers depend on.
 */
export type TeamStorage = SettingsPort &
  MigrationsPort &
  EventsPort &
  IngestKeysPort &
  LifecyclePort &
  QuestionsPort &
  RetentionPort
