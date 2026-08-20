/**
 * THE WINDOW'S FRAME — prd-32 **S5**'s floor, in the one place prd-34 owes it
 * (#563: "the window's minimum size matches prd-32 S5's floor").
 *
 * S5 names three states and two numbers: *primary* at ≥1440×900, *comfortable*
 * at ≥1100×700, and *below minimum* — a single honest panel rather than a
 * broken layout. The two numbers below are those numbers, and
 * `window-frame.test.ts` reads them back out of the PRD's own prose so the pair
 * cannot drift apart silently: a change to S5 that this file does not follow
 * turns that test red naming both values.
 *
 * **Which state is whose.** The shell owns the *minimum*: an Electron window
 * given `minWidth`/`minHeight` cannot be dragged below them at all, so the
 * below-minimum state is unreachable in the app. The web panel still owns it,
 * because the SPA still runs in a browser where nothing stops a 600px viewport
 * — and prd-32 leaves "whether the below-minimum panel is a web surface or the
 * shell's" explicitly open. This is not a ruling on that question: it is the
 * minimum #563 asks for, and the web panel is untouched either way.
 */

export interface WindowSize {
  width: number
  height: number
}

/** S5's *comfortable* floor: dock and scene both present, tighter. The window will not go below it. */
export const WINDOW_MINIMUM: WindowSize = { width: 1100, height: 700 }

/** S5's *primary* size: the full layout. What a first launch opens at. */
export const WINDOW_DEFAULT: WindowSize = { width: 1440, height: 900 }

export interface WindowFrameOptions {
  width: number
  height: number
  minWidth: number
  minHeight: number
  /** The instrument paints its own ground; a white flash between window and page is the shell's, not the SPA's. */
  backgroundColor: string
  show: boolean
  title: string
}

/**
 * The instrument's own floor, per theme: dark is `--color-ice-1000` ("the void
 * — the page's floor") and light is `--color-paper-000` ("the page — the
 * ground the network hangs on"), both from
 * `packages/web/src/theme/theme.css`. Stated here as literals because the
 * shell cannot read a CSS variable before the page exists, and held to the web
 * file's own values by `window-frame.test.ts` so neither can drift.
 *
 * Which one the first frame wears is the OS's answer
 * (`nativeTheme.shouldUseDarkColors`, read in `entry.ts` — this module stays
 * electron-free): the SPA's own preference may be "the other one", but it
 * cannot be read before the SPA has booted, and the page self-heals the frame
 * after it has. What the pair buys is that a person whose whole desktop is
 * light no longer gets one frame of void before their paper page — the
 * mirror of the white flash the dark ground has always prevented.
 */
export const WINDOW_GROUNDS: Readonly<Record<'dark' | 'light', string>> = {
  dark: '#04060c',
  light: '#fcf6eb',
}

/**
 * `show: false` is deliberate: the window is created hidden and shown on
 * `ready-to-show`, which is Electron's own remedy for the white rectangle that
 * otherwise appears while the SPA boots. The background colour underneath it is
 * the instrument's own ground, so the one frame a person does see is the right
 * colour rather than a browser default.
 */
export function windowFrame(overrides: Partial<WindowFrameOptions> = {}): WindowFrameOptions {
  return {
    width: WINDOW_DEFAULT.width,
    height: WINDOW_DEFAULT.height,
    minWidth: WINDOW_MINIMUM.width,
    minHeight: WINDOW_MINIMUM.height,
    backgroundColor: WINDOW_GROUNDS.dark,
    show: false,
    title: 'rhizomorph',
    ...overrides,
  }
}

/**
 * Whether this launch should come up to the tray rather than opening a window.
 *
 * The autostart entry `login-item.ts` writes passes `--hidden`, because being
 * handed a 1440×900 window the instant you log in is not a courtesy — it is the
 * opposite of the one close-to-tray extends. Without this the flag would be
 * written into the `.desktop` file and honoured nowhere, which is the same shape
 * of lie as a preference that saves and does nothing.
 *
 * An exact token match rather than a substring: a repo path that happens to
 * contain the characters `--hidden` must not silently suppress the window.
 */
export function startsHidden(argv: readonly string[]): boolean {
  return argv.includes('--hidden')
}
