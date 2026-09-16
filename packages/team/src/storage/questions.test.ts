import { describe, expect, it } from 'vitest'
import { createRecordingSql } from './recording-sql.js'
import { VIEWER_PROJECT_GUC, VIEWER_ROLE, createQuestionsSql } from './ports/questions/sql.js'

/**
 * THE THREE QUESTIONS, AND THE ROLE THEY ARE READ UNDER (#557).
 *
 * The assertions that matter here are on the **statement tape**, not on the rows, and that is
 * the whole design of this file. `0003_roles_rls.sql`'s header records the measurement: a
 * superuser bypasses RLS unconditionally and FORCE does not close it, so isolation rests
 * entirely on which role reads. A viewer that silently reads as the owner returns **more** rows,
 * never fewer — so every functional assertion anyone would think to write still passes while the
 * isolation is gone. Only the tape can see it.
 *
 * The same is true one layer down and points the other way: the policies read
 * `current_setting('rhizomorph.project_id', true)`, so a transaction that sets the role and
 * NOT the setting admits nothing at all, and the viewer is correct, gated, well-tested and
 * permanently empty.
 */
describe('#557 — every question reads as rz_viewer, scoped to the project', () => {
  const READS = [
    { name: 'readSpendByDay', table: 'spend_by_project_day' },
    { name: 'readLaneState', table: 'lane_state' },
    { name: 'readCollisions', table: 'collisions' },
  ] as const

  for (const read of READS) {
    it(`${read.name} sets the project, then the role, then selects from ${read.table}`, async () => {
      const recording = createRecordingSql()
      const port = createQuestionsSql(recording.sql)
      await port[read.name]('acme-widgets')

      const statements = recording.queries.map((q) => q.sql.replace(/\s+/g, ' ').trim())

      // 1. The project scope, PARAMETERISED — never interpolated.
      expect(statements[0]).toContain(`set_config('${VIEWER_PROJECT_GUC}'`)
      expect(recording.queries[0]?.values).toEqual(['acme-widgets'])

      // 2. The role, and it is SET LOCAL so it cannot outlive the transaction.
      expect(statements[1]).toBe(VIEWER_ROLE)

      // 3. …and only then the read.
      expect(statements[2]).toContain(`from ${read.table}`)
      expect(statements).toHaveLength(3)
    })
  }

  /**
   * THE WORD `local` IS PINNED INDEPENDENTLY OF THE CALL SITE (review of #574).
   *
   * Every claim this port makes about `SET LOCAL` over `SET` — in `sql.ts`, in `port.ts`, and in
   * ADR-0057's Consequences — rested on one assertion comparing the statement against the
   * constant that names it. Mutating BOTH, which is exactly how a refactor moves a shared
   * spelling, left the whole team package green at 621 tests: nothing in the repo asserted the
   * word `local`. `sql.ts`'s own docblock predicted it — "the test is what holds the two
   * spellings together" — and that was the property it did not have.
   *
   * `SET` instead of `SET LOCAL` survives the COMMIT, so on a pooled connection the next caller
   * inherits `rz_viewer` and loses writes, or — silently, and far worse — a connection that
   * failed to reset hands the next viewer the owner's rights and every row in the database.
   */
  it('the role statement is SET LOCAL, asserted on the constant and not only on the tape', () => {
    expect(VIEWER_ROLE).toMatch(/^set local role /)
    expect(VIEWER_ROLE).toBe('set local role rz_viewer')
  })

  it('the project scope is set with set_config, which is the only parameterisable form', () => {
    expect(VIEWER_PROJECT_GUC).toBe('rhizomorph.project_id')
  })

  it('all three run inside ONE transaction — the role must not leak past COMMIT', async () => {
    const recording = createRecordingSql()
    const port = createQuestionsSql(recording.sql)
    await port.readLaneState('acme-widgets')

    // The log interleaves BEGIN/COMMIT markers with each statement.
    expect(recording.log[0]).toBe('BEGIN')
    expect(recording.log[recording.log.length - 1]).toBe('COMMIT')
    expect(recording.log.filter((l) => l === 'BEGIN')).toHaveLength(1)
  })

  it('the project id is a BOUND VALUE in every read, never spliced into the text', async () => {
    const recording = createRecordingSql()
    const port = createQuestionsSql(recording.sql)
    await port.readCollisions("bobby'; drop table events; --")

    for (const q of recording.queries) {
      expect(q.sql).not.toContain('drop table')
    }
    expect(recording.queries.some((q) => q.values.includes("bobby'; drop table events; --"))).toBe(true)
  })

  it('REPETITION — the same question twice opens two transactions and sets the role in both', async () => {
    const recording = createRecordingSql()
    const port = createQuestionsSql(recording.sql)
    await port.readSpendByDay('acme-widgets')
    await port.readSpendByDay('acme-widgets')

    const roleStatements = recording.queries.filter((q) => q.sql.trim() === VIEWER_ROLE)
    expect(roleStatements).toHaveLength(2)
    expect(recording.log.filter((l) => l === 'BEGIN')).toHaveLength(2)
  })

  it('costUsd stays a STRING — numeric(18,6) is exact and Number() would round money', async () => {
    const recording = createRecordingSql()
    recording.script([]) // set_config
    recording.script([]) // set local role
    recording.script([{ project_id: 'acme-widgets', day: '2026-09-16', cost_usd: '1234.567890', events: 7 }])
    const port = createQuestionsSql(recording.sql)
    const rows = await port.readSpendByDay('acme-widgets')
    expect(rows[0]?.costUsd).toBe('1234.567890')
    expect(typeof rows[0]?.costUsd).toBe('string')
  })
})
