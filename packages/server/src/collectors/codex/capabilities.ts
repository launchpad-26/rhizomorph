import type { AdapterCapabilities } from '@rhizomorph/core'

/**
 * codex's declared capabilities, per prd-26 ruling 2 — declared from the
 * capture (`./fixtures/CAPTURE.md`), never from documentation. codex is not a
 * `Collector`: no rollout-tailing organ exists yet (ruling 4's fence keeps
 * `sessionlog/collector.ts` and a new codex directory-watcher out of this
 * issue), and the OTLP path it does have today is the *same* receiver claude's
 * export already lands on (`../otel/index.ts`, unmodified — CAPTURE.md
 * Finding 6). So every level below is backed either by that shared receiver
 * code run over codex's own real fixtures (`conformance/codex.test.ts`), or
 * — where nothing runs yet — an honest `absent`/`partial` naming the real
 * capture that shows the gap, never a guess.
 */
export const CODEX_CAPABILITIES: AdapterCapabilities = {
  identity: {
    level: 'partial',
    reason:
      'lane/role/instance resource attributes only when the operator configures OTEL_RESOURCE_ATTRIBUTES at launch — proven by capture (CAPTURE.md Finding 2): codex honors the exact bare `lane`/`role`/`instance` keys `rhizomorph env` already emits, unmodified. The rollout also carries a structural cwd/session_id (like claude\'s transcript directory), but nothing reads it yet — no collector watches `~/.codex/sessions/`.',
    remedy: 'a codex rollout-tailing collector (out of this issue\'s fence) would add structural identity from cwd, alongside the OTLP route above.',
  },
  liveness: {
    level: 'partial',
    reason: 'export cadence only — codex\'s OTLP flushes on its own schedule, not a poll, the same architecture as claude\'s OTLP (see `../otel/capabilities.ts`).',
    remedy: 'a codex rollout-tailing collector would give a live liveness read from the rollout\'s own append cadence (CAPTURE.md Finding 3 shows the file is written incrementally, turn by turn).',
  },
  /**
   * Backed by `conformance/codex.test.ts` feeding the real, trimmed
   * `codex-cli-0.146.0-otlp-traces-turn.json` through the unmodified
   * `parseTracesExport` — but that fixture has 3 of its original 59 real
   * spans excluded (CAPTURE.md Finding 7, #510): codex's real root spans
   * carry `parentSpanId: ""`, which the receiver's `nonEmptyString.nullable()`
   * schema rejects, throwing uncaught and costing the *whole* export its
   * batch. In production this means the receiver answers that POST with
   * `400` and records one `collector.error` (`api/otel.ts`'s error handler,
   * lines 38-47) — a recorded, honest refusal, not a silent crash — but it
   * also means every other span in that same batch is lost with it, not just
   * the offending root span. `activity: provided` holds for a codex trace
   * export whose root spans don't trip #510; it is not yet resilient to a
   * codex export the way the sibling per-span error paths already are.
   */
  activity: { level: 'provided' },
  attention: {
    level: 'absent',
    reason:
      'no captured codex span or log event represents a blocked-on-approval/waiting-for-user state. Every capture ran with an auto-approving policy (CAPTURE.md), so a real pause was never exercised, and none of the ~350 span names this issue captured resembles one.',
    remedy: 'capture a session under an interactive approval policy (`-a on-request` or `-a untrusted`) that actually pauses for a human, to test whether codex\'s span/log vocabulary names a blocked state at all.',
  },
  telemetry: {
    level: 'absent',
    reason:
      'codex\'s own metric name (`codex.turn.token_usage`) and log attributes don\'t match the receiver\'s fixed allowlist (`claude_code.token.usage`) — CAPTURE.md Finding 6 — so this path emits zero `llm.usage` events today. The rollout DOES carry real per-turn and cumulative token counts (Finding 5), but nothing reads it yet.',
    remedy:
      'either a `codex.*` mapping profile in the receiver\'s parsers (a fence widening to be proposed and recorded on this issue before the change, per ruling 1) or a rollout-tailing collector reading the `token_count` event directly.',
  },
  cost: {
    level: 'absent',
    reason: 'no dollar figure appears anywhere in any of the four real captures — rollout, OTLP metrics, or OTLP logs (CAPTURE.md Finding 5). Unlike claude, codex\'s CLI computes no cost today.',
    remedy: 'none available until codex\'s own CLI computes one; a pricing-table estimate would need explicit `est.` flagging per prd-15 ruling 3 and was not attempted here since no metric backs even an estimate.',
  },
}
