/**
 * The scene's colours, mirroring the shell's neon tokens (`theme/theme.css`).
 *
 * Duplicated as JS literals rather than read from CSS because three.js needs
 * real colour values at material-construction time, not computed styles.
 * If `theme.css` moves, move these with it.
 */
export const PALETTE = {
  void: '#05060a',
  raised: '#0d0f1a',
  line: '#1c2033',
  cyan: '#4deaff',
  magenta: '#ff4dd8',
  amber: '#ffc857',
  slate: '#64748b',
  dim: '#243049',
} as const

/** Station colour by workmux agent status; falls back to cyan (nominal). */
export const STATUS_COLOR = {
  working: PALETTE.cyan,
  waiting: PALETTE.amber,
  done: PALETTE.magenta,
} as const

export const TRUNK_COLOR = '#8fe9ff'
