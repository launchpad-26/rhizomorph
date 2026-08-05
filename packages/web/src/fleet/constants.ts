// ── tuned constants ─────────────────────────────────────────────────────────
// Every threshold in the instrument lives here, named, with the reason it has
// the value it has. A number tuned inside a detector is a number nobody can
// find later.

/**
 * Tokens come from the collector with cache-tier detail, dollars from the one
 * with authority (architecture.md, prd1). Counting both collectors' token
 * reports would double-count every request they both saw.
 */
export const TOKEN_ORIGINS = ['sessionlog'] as const

/**
 * #159 — the fleet table's own OUTPUT-cell sparkline (dashboard-IA spike §3
 * medium-value item, "legend-as-table + sparklines in cells"): a trailing
 * half hour, sliced into six-minute buckets. Same {@link TOKEN_ORIGINS}
 * filter every other output-token number in this file already uses, so the
 * spark's shape never disagrees with the headline figure it sits beside.
 */
export const SPARK_WINDOW_MS = 30 * 60_000
export const SPARK_BUCKET_COUNT = 10

/** How far back LOOPING looks for a repeating tool cycle. */
export const LOOP_WINDOW_MS = 4 * 60_000
/** A one-tool "cycle" is not a cycle; six is longer than any real stuck loop. */
export const LOOP_MIN_PERIOD = 2
export const LOOP_MAX_PERIOD = 6
/** Twice could be a coincidence. Three times is a wheel. */
export const LOOP_MIN_REPEATS = 3

/**
 * FROZEN — minutes of *total* silence. Well past core's `DEFAULT_FLATLINE_MS`
 * (5m) on purpose: this one escalates to BROKEN and flips the tab title, so it
 * has to outlast a long compile, a big test run and a slow model response.
 */
export const FROZEN_AFTER_MS = 8 * 60_000

/**
 * The second witness (dogfooding-born, #133): a pane's own repaint is one sign
 * of life, but a delegating lane looks visually still — no content-hash change
 * — for exactly as long as its subagent is busiest, which is precisely when a
 * pane-only reading is most wrong. `llm.usage`/`tool.activity` already reach
 * `lastWorkTs` through `LaneSpend.lastTs`; `trace.span` does not — `spend.ts`
 * keeps spans out of the money layer by design (prd9 ruling 4) — so this file
 * reads `state.traces.spans` directly and folds a lane's latest span into the
 * same `lastWorkTs` FROZEN and WAITING already read. A lane is only silent on
 * the work witness when NEITHER a usage/tool event NOR a span has landed
 * recently; a still pane with a live trace reads `working`, not a summons.
 *
 * Windowed to `FROZEN_AFTER_MS` — the widest silence any detector in this file
 * cares about — because a span older than that could not rescue a lane from
 * FROZEN either way, and scanning further back would just be paying to learn
 * a number nothing downstream will use.
 */
export const SPAN_WITNESS_WINDOW_MS = FROZEN_AFTER_MS

/** Silence this long, with the pane still moving, smells like a raised hand. */
export const WAITING_QUIET_MS = 75_000
/** …and the pane must have moved this recently for that inference to hold. */
export const WAITING_PANE_FRESH_MS = 45_000

/** EXPENSIVE — this many times the fleet's median output rate… */
export const EXPENSIVE_MULTIPLE = 3
/** …and never below this floor, so a fleet of near-zeros has no "outlier". */
export const EXPENSIVE_FLOOR_PER_MIN = 300

/** Past this a calm lane has simply gone quiet: not broken, just cold. */
export const IDLE_AFTER_MS = 90_000
