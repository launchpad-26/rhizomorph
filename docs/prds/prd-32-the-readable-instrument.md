# prd-32 — the readable instrument: type that loads, colour that computes

> **Status:** proposed — implements the design charter's binding §3, §4 and §6 rulings
> (`docs/design/charter.md`, PR #451): the loaded faces, the mirror tests, the `--text-*` ramp
> structure, the heading utility, the named mono registers, role tokens, alias retirement, the
> `FALLBACK_HUE` pin, contrast as arithmetic and the global `:focus-visible` floor — and **owns
> charter §8's light-band pending ruling** (light-mode severity and the band). First mover of
> the four UI PRDs: every wave-1 target is zero-claimant. Milestone 18. Ramp values and the
> light palette iterate with hchristina on the companion; structure, units and floors are
> charter law. Citations verified at origin/main `e8fed56`.

## Problem

The instrument has never rendered in its own typeface. `--font-sans` and `--font-mono` name
Inter and JetBrains Mono; nothing loads them, so every session has run in Segoe UI and Consolas
— the named identity is a comment. There is no type ramp: sizes are pixel literals with no
tokens and zero rem, so browser font preferences are ignored entirely. Colour discipline is
prose: the contrast ratios that justify the legibility floor exist as a comment, computed
nowhere; dead aliases sit in `theme.css` waiting to be used wrongly; the last unpinned hexes
hide in a hook. And there is exactly one theme, on an instrument whose charter identity now
extends to two — a light-ground reading of severity that no law yet governs. None of this is
redesign; it is the instrument finally doing what its own tokens already claim.

## Evidence

- **No font has ever loaded.** `packages/web/package.json` dependencies: `core`, `d3-*`,
  `perfect-freehand`, `react` 19.2.8, `react-dom`, `simplex-noise` — no `@fontsource` anywhere.
  `packages/web/index.html` is 12 lines with no font links. The charter's census (§3): 239
  sizing sites, mode `text-[10px]` (×102), ceiling `text-sm`, zero rem — and `theme.css` has
  zero `--text-*` tokens.
- **The drift a mirror test refuses, already caught once:** `attention.css` references
  `--duration-age-pulse-seam`, which does not exist — it silently falls back to 6800 ms while
  `--duration-breath` is 5400 ms.
- **Alias retirement is a pure delete.** The six dead aliases (`--color-void`,
  `--color-void-raised`, `--color-void-line`, `--color-neon-cyan`, `--color-neon-amber`,
  `--color-neon-magenta`) and the four deprecated glow utilities still exist and have zero
  production callers — only their `theme.css` definitions and one `legibility.test.ts` mention.
- **The last unpinned hexes:** `FALLBACK_HUE` at `panels/attention/useTabSignal.ts:25`
  hardcodes `#ffc857` and `#ff3d68` outside the mirror suite.
- **Focus is hand-rolled at 18 sites in three idioms** (charter §6), and
  `panels/collisions/index.tsx:76` wears `ring-needs-you` — a status hue as focus chrome.
- **Light mode does not exist at all:** no switch, no `data-theme`, no `prefers-color-scheme`
  anywhere in `theme/`.
- **The ground is uncontended.** Zero open PRs touch `packages/web` (open PRs #431, #432, #451,
  #462 are docs-only); every wave-1 target is zero-claimant.

## Success

1. A cold start on a fresh profile renders Inter and JetBrains Mono with no network. **Not met
   while** any surface falls back to Segoe UI or Consolas, or a font arrives from a CDN.
2. Drift fails the build. **Not met while** a referenced token can lack a definition (the
   age-pulse-seam class of bug), or the canvas `FONT` record can diverge from `theme.css`
   unnoticed.
3. Contrast is a calculation. **Not met while** the documented ratios exist only as prose, or a
   token edit can cross the legibility floor without a red suite — in either theme.
4. Light mode is real, lawful and switchable. **Not met while** dark's four 9b numbers move, or
   severity on light ground is carried by pretending brightness still means what it meant on
   the void, or the switch behaves as status rather than chrome.
5. Focus is one token. **Not met while** any focus ring wears a status hue.
6. The era ends with the ramp adopted. **Not met while** the heading idiom or a raw pixel size
   survives the wave-4 sweeps, or a new size lands as a literal after the tokens exist.

## Non-goals

- **Not the scene's vibrancy.** The ambient layer, growth and the ceilings are prd-33's pending
  rulings; this PRD touches `scene/palette.ts` only to make it per-theme tables, and
  coordinates `scene/marks.test.ts` ceiling assertions with prd-33.
- **Not the disclosure card or the conversation chrome** — prd-30 and prd-31 own those; the
  wave-4 sweeps restyle idioms only after their structural changes land.
- **Not a redesign.** The faces were always Inter and JetBrains Mono; dark remains the source
  of truth, and role tokens derive from the dark ramp, never beside it.
- **No new hue**, in either theme.

**Rejected alternatives.** *CDN fonts* — a localhost-only instrument never reaches a CDN; the
charter says so in the same breath it names the faces. *A token pipeline dependency* (Style
Dictionary and kin) — `palette.test.ts` already pins the canvas palette by parsing `theme.css`
off disk; the house mirror mechanism extends, a build stage does not land. *Deriving light
arithmetically from dark* — "brighter than the calm world" cannot mean the same thing on white;
inversion transports the numbers and loses the meaning. *`prefers-color-scheme` alone, no
switch* — the OS default is the default, not the preference; an operator in a dark room
overrides it in chrome.

## What already exists (do not rebuild)

The mirror mechanism: `palette.test.ts` parses `theme.css` off disk and pins the canvas palette
— fonts, durations and `FALLBACK_HUE` join it; the mechanism is not reinvented. The `figures`
utility is the instrument's widest convention (39 files) and becomes the named mono register it
already is in practice. The legibility floor and its self-policing allowlist stand; contrast
arithmetic turns their numbers from claim into computation. The heading idiom — one string
copy-pasted across the Conversation, Trace and Activity headers — is the utility's exact spec.

## Rulings

Each is a **proposed** verdict with its reasoning; no operator has ruled on any of them.

## Ruling 1 — the faces load, self-hosted, and drift fails the build

`@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, imported at the app
entry; the canvas `FONT` record (`scene/paint.ts`) aligns to the tokens. Mirror tests land for
the font stacks and every `--duration-*` token — the first catch is already known: the
age-pulse-seam reference that falls back to 6800 ms today either gets its token or loses its
line, and the class of bug dies with the test.

## Ruling 2 — a rem ramp in two registers, one heading utility, two named mono registers

`--text-*` tokens in rem: the _reading_ register (floor 0.75rem, body 0.8125rem) for
conversation, tooltips and prose; the _instrument_ register (0.625rem legal on data-dense
surfaces; 0.5625rem the absolute floor, `aria-hidden` ornament only). The heading idiom becomes
one named utility. _figures_ and _code-voice_ get their names. Structure, units and floors are
charter law; exact values are tuned with hchristina on the companion.

## Ruling 3 — colour becomes roles and arithmetic, and the dead names are deleted

Role tokens — `--surface-*`, `--ink-*`, `--line-*` — derive from the dark ramp. The six aliases
and four glow utilities are deleted outright: zero production callers, a pure delete, verified.
`FALLBACK_HUE` joins the mirror suite. A contrast law computes the documented ratios — 5.1:1 at
the floor, 3.3:1 and 2.4:1 below it — from the tokens, per theme, so the floor is arithmetic in
both worlds. The global `:focus-visible` floor token lands here and retires the three
hand-rolled idioms, `panels/collisions/index.tsx:76`'s status-hue ring first.

## Ruling 4 — light mode, user-switchable; this PRD owns the light-band pending ruling

Dark's four 9b numbers do not move — charter §2.2 is the reason. A per-theme band is re-derived
beside them, and severity on light ground travels by enclosure, weight and saturation, never by
pretending brightness still means what it meant on the void. `scene/palette.ts` becomes
per-theme tables and the colour mirror test doubles. The switch is chrome, not status: a
persisted preference defaulting to `prefers-color-scheme`. `scene/marks.test.ts` ceiling
assertions are coordinated with prd-33: whoever lands second rebases; the numbers never move.

## Ruling 5 — the tabbable dock is the panel IA, and the TIDE never joins the tabs

The panel column consolidates into a tabbable dock — its own wave, because it is an IA change,
not a restyle. prd-13 ruling 1 is respected in full: the TIDE is the replay bar's body, never a
panel, and never a tab.

## Sequencing (waves, each gated as ever)

`packages/web/src/lab/` is prd-28's territory; no wave of this PRD enters it.

1. **Keystone, and the era's first dispatch:** wave 1 is entirely additive and entirely
   zero-claimant — fonts, tokens, the alias delete, the mirror tests, the contrast law, the
   focus token. It waits on no other PRD, and nothing else in the era dispatches before it —
   every later wave everywhere consumes these tokens.
2. Light theme — DOM first, then canvas (the per-theme tables; the mirror doubles).
3. The dock.
4. **The sweeps — the last wave of the whole era:** heading-utility adoption and the rem
   migration, repo-wide, after prd-30, prd-31 and prd-33's structural changes land. A sweep
   that runs earlier re-lays ground the other PRDs are about to dig.

Unfiled work implied, described not numbered: the font/token/mirror landing; the contrast law;
the light theme in two steps; the dock; the two sweeps.

## Open questions

- **Exact ramp values and the light palette** — hchristina's, on the companion. Open, not ruled.
- **Where the theme switch sits in chrome** — beside the connection chrome, or in a settings
  disclosure. Open, not ruled.
- **The dock's tab set and order** — groomed with the IA in front of us, not here.
- **Whether the contrast law rides the palette mirror or its own suite** — mechanism open; the
  obligation is not.
