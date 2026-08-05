import type { AdapterCapabilities } from '@rhizomorph/core'

/**
 * The OTLP receiver isn't a `Collector` (it's routes + pure parsers — see the
 * adapters spike's thread 4), so it has no `poll()` to attach `capabilities`
 * to the way every other collector in this fence does. This is what it
 * provides once an operator has actually wired the env vars in
 * (`rhizomorph env <lane>`, prd15 ruling 5's L1) — callers gate its inclusion
 * on that live fact themselves (`doctor`'s existing `checkTelemetryEnv`,
 * `/api/meta`'s own env read), the same way a disabled collector's
 * capabilities are overridden at the call site rather than baked in here.
 *
 * Levels restated from the adapters spike's floor→ceiling ladder (L1 row):
 * lane/role resource attrs are `[Ran, claude]` but untested for codex/gemini
 * (`partial`); spans export on end, never live (`partial` attention, never
 * `provided` — OTLP's `tool.blocked_on_user` is retrospective by
 * construction); dollars are authoritative only for claude today, a flagged
 * estimate elsewhere (`partial` cost, not `provided`).
 */
export const OTEL_CAPABILITIES: AdapterCapabilities = {
  identity: {
    level: 'partial',
    reason: 'lane/role resource attributes only when the CLI is configured to send them — proven for claude, untested for codex/gemini',
    remedy: 'a dialect-verification capture for the other CLIs would upgrade this',
  },
  liveness: {
    level: 'partial',
    reason: 'export cadence only — spans and metrics arrive on their own schedule, not a poll',
    remedy: 'the sessionlog transcript organ gives a live liveness read alongside this',
  },
  activity: { level: 'provided' },
  attention: {
    level: 'partial',
    reason: '`tool.blocked_on_user` spans export only when the span ends — retrospective, never live',
    remedy: 'a hook beacon or workmux gives live, declared attention',
  },
  telemetry: { level: 'provided' },
  cost: {
    level: 'partial',
    reason: 'authoritative dollars only where the CLI computes them (claude today); other CLIs get a flagged pricing-table estimate',
    remedy: 'per-CLI OTLP cost export, as each CLI adds it',
  },
}
