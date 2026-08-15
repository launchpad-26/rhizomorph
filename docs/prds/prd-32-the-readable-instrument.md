# prd-32 — the readable instrument: type that loads, colour that computes

> **Status:** proposed · **Kind: specifying** (`docs/prds/README.md` — this PRD carries the
> specification for surfaces a stranger will build without the author in the room).
> Implements the design charter's binding §3, §4 and §6 rulings
> (`docs/design/charter.md`, PR #451): the loaded faces, the mirror tests, the `--text-*` ramp
> structure, the heading utility, the named mono registers, role tokens, alias retirement, the
> `FALLBACK_HUE` pin, contrast as arithmetic and the global `:focus-visible` floor — and **owns
> charter §8's light-band pending ruling** (light-mode severity and the band). First mover of
> the era: every wave-1 target is zero-claimant, and **every later wave everywhere consumes
> these tokens**. Milestone 18. Ramp values, the light palette and the category family are
> decided here (rulings 6–10) and reviewed by the team; structure, units and floors are charter
> law. Citations verified at origin/main `e8fed56`; rulings 6–10 added 2026-08-15 from
> `docs/design/ui-2.0-decisions.md`.

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

## Ruling 6 — the ramp's values are decided: reading rises to 14px-equivalent

Ruling 2 fixed the structure and left the numbers to the artifact conversation. They are settled
here. **Reading register: body `0.875rem` (14 px-eq), floor `0.8125rem` (13 px-eq)** — used for
conversation, disclosure cards, explanations, prose, and any sentence a human is meant to read
rather than compare. **Instrument register: `0.6875rem` (11 px-eq) default, `0.625rem` (10 px-eq)
legal on data-dense surfaces, `0.5625rem` (9 px-eq) the absolute floor and `aria-hidden` ornament
only** — tables, figures, trace rows, chips.

The reason the reading register rises so far: today's dominant size is 10 px on surfaces people
read for two hours at a stretch, and it is expressed in pixels, so a person who has set their OS
or browser text larger gets **no change at all**. Rem is the accessibility half of this ruling and
it is not optional (ruling 9). A 40% jump in reading size will visibly reflow layouts; that is the
sweeps' work (wave 4), and it is the point rather than a side effect.

## Ruling 7 — light mode is warm paper, and severity is re-carried, not re-lit

Ruling 4 owns the pending light-band ruling; this settles its character. The light ground is
**warm off-white, not clinical white** — an eye that reads an instrument for hours is not served
by maximum contrast, and the warm ground is the one that gives the tissue family (ruling 8) a
material to sit against. Inks are **deep plum-grey rather than black**, hairlines are low-contrast.

Severity on light ground travels by **weight, enclosure and saturation** — never by brightness,
because "brighter than the calm world" is meaningless on a ground that is already at the top of
the range. BROKEN gains a cartouche and weight where on the void it gained luminance; the alarm
grammar keeps its exclusivity by a different mechanism, and the per-theme band is re-derived
beside the dark one. **Dark's four numbers do not move** (`RECEDE 0.30`, `CALM_CEILING 0.78`,
`ALARM_FLOOR 0.84`, `CALM_FLOOR 0.15`).

## Ruling 8 — a bounded category family, extended from the organism's own tissue

**This amends the most-repeated constraint in the record, deliberately and bounded.** "No new
semantic hue" stands: the six status hues remain the entire vocabulary of *state*. What lands
beside them is a **category family** — a small, low-chroma set for *kind of work*, extended from
the tissue accent the scene already owns (OKLCH H ≈ 295.5), so category colour reads as "the
organism's own material" rather than as UI decoration. One organism, many tissues.

The caps that keep status dominant, each a number a law test can hold:

- **Chroma ceiling well below every status hue** — category is a tint, never a signal.
- **No glow, ever.** Glow utilities remain alarm grammar; a category tint gets no halo.
- **Never above `CALM_CEILING`** — category colour is structurally incapable of entering the
  alarm band.
- **Angular clearance from `--color-notice`** (cyan) measured in OKLCH, so the violet family
  cannot drift into the one accent prompts already carry.
- **Greyscale survival**: the category distinction must remain readable with colour removed —
  by lightness, form or label — which is law 9 restated for the new family.

Where it may appear: conversation and trace rows, the run view, the fleet list and panels, and
**the scene** — where prd-33 ruling 6 binds it to a different channel than status.

## Ruling 9 — rem is the accessibility floor, and contrast is computed per theme

Every size in the ramp is rem, so the OS and browser text-size preference reaches the instrument
instead of being overridden. The contrast law (ruling 3) computes its ratios **per theme** from
the tokens, so a light-theme regression fails the same suite a dark-theme one does. Keyboard
reachability is charter §6's, binding, and consumed here: **one `:focus-visible` token, never a
status hue, on every interactive element in the app.** Screen-reader support for non-scene
surfaces is **explicitly deferred** — named here so its absence is a decision on the record
rather than an oversight.

## Ruling 10 — navigation is persistent, and the window has a floor that speaks

Navigation exists on **every** surface, in the same place, always. Today it renders only on the
balcony: open a lane, a recording, the lab or connect and the only way back is browser history.
That is not a redesign question, it is a defect with a layout shape.

The window is **laptop-first**: ~1440×900 is the primary target, the layout scales up
gracefully, and below a **hard minimum of ~1100×700 the app says so in words** rather than
breaking silently — the same honest-gap voice used for missing data, applied to its own frame.
Since the instrument ships as a desktop application (prd-34), there is no unknown browser and no
mobile case to serve; the minimum is a real contract rather than a guess.

## The specification

Six answers per surface, per `docs/prds/README.md`.

### S1 — the type ramp

**What and why.** One token set, two registers, so "13 px" cannot be spelled two ways across 47
sites and a reader's preference is honoured.

| token | rem | px-eq | register | used by |
|---|---|---|---|---|
| `--text-read-body` | 0.875 | 14 | reading | conversation turns, disclosure cards, prose, empty states |
| `--text-read-floor` | 0.8125 | 13 | reading | secondary prose, captions that are still sentences |
| `--text-inst` | 0.6875 | 11 | instrument | panel bodies, list rows, chips |
| `--text-inst-dense` | 0.625 | 10 | instrument | tables, trace rows, figures in columns |
| `--text-inst-floor` | 0.5625 | 9 | instrument | `aria-hidden` ornament only |
| `--text-heading` | 0.625 | 10 | instrument | the one heading utility (uppercase, tracked) |

**States.** No states — tokens are static. **Data source.** None; these are constants mirrored
by test against `theme.css`. **Interaction.** Scales with the user's root font size; nothing in
the app overrides it. **What would make it wrong:** any new pixel literal after wave 1; any size
outside the table; a `text-xs`-versus-`text-[12px]` pair returning. **Acceptance:** a law test
enumerates the tokens, fails on a raw `text-[Npx]` outside the allowlist, and asserts every value
is rem.

### S2 — the colour system

**What and why.** Roles rather than steps, so two themes are possible and no consumer names a
luminance directly.

- **Role tokens** — `--surface-{floor,panel,raised,line}`, `--ink-{primary,body,dim,inverse}`,
  `--line-{hair,strong}` — derived from the dark ramp, redefined per theme.
- **Status hues** — the six, unchanged, plus `--color-necrotic`. Untouched by this PRD.
- **Category family** — `--category-{1..4}` (ruling 8), tissue-derived, capped.
- **Focus** — `--focus-ring`, one token, never a status hue.

**States.** `dark` (source of truth) · `light` (warm paper). Theme is a `data-theme` attribute on
the root, persisted, defaulting to `prefers-color-scheme`. **Data source.** None — constants,
mirrored to `scene/palette.ts` per theme by the existing mirror test. **Interaction.** Switched
from settings (prd-35), never from status chrome. **What would make it wrong:** a status hue used
as focus or category; a category tint above `CALM_CEILING`; light derived by inverting dark;
any of the four immovable numbers moving. **Acceptance:** the contrast law computes every
role/ink pair per theme against the documented floors; the palette mirror doubles; a rigged
violation of the category caps turns the suite red.

### S3 — the dock

**What and why.** The three small panels stop competing for vertical space; one surface, full
width, one thing at a time. The fleet is **not** in the dock — it merged into the scene
(prd-36).

**Tabs, in order:** spend · collisions · feed · trace. **States.** *live* (a tab's own content) ·
*empty* (the panel's own zero-with-evidence voice, never a hidden tab) · *loading* (only where a
tab fetches; the fold-backed tabs have no loading state) · *error* (the tab renders its
honest-gap line and the dock stays usable) · *degraded* (a collector is down; the tab says which
and how to restart it) · *replay* (content follows the scrub position) · *demo* (chrome marks it
simulated, inherited from the app frame). **Data source.** All four read the fold; nothing here
fetches except trace detail. **Interaction.** Click or arrow-key between tabs, roving tabindex,
the selected tab persists per repo; `Escape` never closes it (it is not a dialog). **What would
make it wrong:** a tab hiding an empty state instead of voicing it; the TIDE appearing as a tab
(prd-13 ruling 1 forbids it); tab state stored globally rather than per repo. **Acceptance:**
`PanelGrid`'s curated-order tests are rewritten for the dock; a test asserts the TIDE is not a
tab; each tab's empty state renders its evidence line.

### S4 — navigation

**What and why.** Every surface reachable from every surface. **States.** *default* · *active*
(the current surface) · *unavailable* (a surface that cannot apply — e.g. lab during replay —
renders disabled with a reason, never hidden). **Data source.** The router. **Interaction.** Real
`<a href>` so modifier-clicks behave; plain click routes in-app; keyboard reachable with the one
focus token. **What would make it wrong:** any surface rendering without it; a disabled item with
no stated reason. **Acceptance:** a test asserts the nav renders on all routes including
`/lane/:handle`, `/recordings`, `/lab`, `/connect` and settings.

### S5 — the window

**What and why.** A known frame, since the app ships as a desktop application. **States.**
*primary* (≥1440×900, full layout) · *comfortable* (≥1100×700, dock and scene both present,
tighter) · **below minimum** (a single honest panel: what the minimum is, what the current size
is, and that the instrument will resume when resized — never a broken layout). **Data source.**
The window. **Interaction.** Resize. **What would make it wrong:** silent breakage below the
floor; a layout that assumes a browser's mobile viewport. **Acceptance:** a test renders below
the floor and asserts the honest panel; the shell's minimum window size is set in prd-34's
Electron config to match.

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

- ~~Exact ramp values and the light palette~~ — **settled by rulings 6 and 7.**
- ~~Where the theme switch sits in chrome~~ — **settled: settings owns it (prd-35).**
- ~~The dock's tab set and order~~ — **settled by S3**: spend · collisions · feed · trace, the
  fleet having merged into the scene (prd-36).
- **Whether the contrast law rides the palette mirror or its own suite** — mechanism open; the
  obligation is not.
- **The category family's exact four values** — the caps in ruling 8 are law; the hexes are
  chosen against them at wave 1 and reviewed by the team.
- **Whether the below-minimum panel is a web surface or the shell's** (prd-34 could refuse to
  size the window below the floor at all). Open, not ruled.
