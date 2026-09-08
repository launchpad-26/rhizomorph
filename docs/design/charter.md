# the design charter — through-lines for type, colour, motion and law

> A standing normative register — `docs/architecture.md`'s sibling for the visual
> instrument. This document rules; every other design surface restates it. It is
> amendable by pull request under the house amendment process (§2.4). The four law
> **amendments** it names were proposed here and **ruled 2026-08-15** by prd-32
> (rulings 7 and 8) and prd-33 (rulings 9 and 10); each is recorded inline where it
> lands, in §4 and §5.
>
> 2026-08-13 · verified against `origin/main` at `e62fd93` (post-#428) — a sha in the
> deleted repo's history, unreachable from this tree.
> 2026-08-24 · re-verified against `main` at `4140f6b`: law 10's numbers, §8's two
> tensions and the ground-truth notes in §3, §4 and §6 corrected against landed work;
> the rest stood.
>
> Visual companion: [`charter-companion.html`](./charter-companion.html) — open it in a
> browser; it renders both registers, the band, and every table above with the faces
> actually loaded. The artifact restates, never rules.

## 1 · identity

The Rhizomorph is a living instrument, not a dashboard: a fleet you glance at from the
periphery, that earns that periphery by being ignorable until something genuinely needs
you. It practises calm technology — attention is bought only with the alarm grammar,
never with decoration. Its identity is dark-first, the ice register on the void, and
that identity now extends to two real themes, user-switchable, with dark remaining the
source of truth. Its typography is mono-forward: an instrument that reports figures
speaks mono, and prose is the deliberate exception that reads as human. One aesthetic
law outranks every other: an ugly surface that refuses to lie beats a gorgeous one
that ranks.

## 2 · the law register, codified

Every visual law in force, in one table. Test paths are relative to
`packages/web/src/`; a law whose test is "by construction" says so honestly rather
than borrowing confidence from a suite that does not exist.

| law | source ruling | test | meaning |
| --- | --- | --- | --- |
| **law 9** | prd-03 | by construction in `fleet/sigils.tsx` — every state is glyph + word; `theme/category.test.ts` "law 9 — the two poles survive greyscale and a red-green reader" holds `--color-working` / `--color-broken` apart in greyscale and under both red-green dichromacies, per theme (#39) | colour is never the sole carrier of a state; every mark survives greyscale |
| **law 9a** | prd-04 ruling 3 (`docs/prds/done/prd-04-human-facing.md:20-34`) | `scene/marks.test.ts:1415` "says what the fleet is doing in a colour a stranger can guess (law 9a)"; `:3297` "shimmers in luminance only, never in hue" | hue is meaning, and each hue means one thing — the full table is §2.1 |
| **law 9b** | prd-04 ruling 3; amended once by prd-10 ruling 4 | `scene/marks.test.ts:497` (calm under the ceiling), `:546` (needs-you inside the band), `:507` (alarms exempt from fades); `:3000` "law 9b, amended within reason" | the brightness band and the alarm grammar own attention, not hue exclusivity — the numbers are §2.2 |
| **the CALM_FLOOR law** | prd-04 ruling 3 | `scene/marks.test.ts:1403` "renders every thread bright enough to actually read (CALM_FLOOR)" | a living thread never dims below 0.15 on a calm fleet; a frozen thread sits below it on purpose — absence of light is what FROZEN encodes |
| **law 10** | prd-05 ruling 4, adopted as law; prd-10 ruling 10 adds the fourth class; prd-33 ruling 9 adds the fifth and ruling 10 raises the event cap (both 2026-08-15) | `scene/motion.test.ts:39-270`; the classes at `scene/motion.ts:49` | five closed motion classes — ambient 4–8 s ≤3%, event 400–600 ms ≤7 concurrent (measured, alarms exempt), structural ~800 ms damped ≤2, dissolution ≤240 pooled motes, growth on its own typed-cause budget — plus the ALARM throb (1200→2600 ms with age); nothing in the picture moves outside them |
| **law 11** | prd-03; stated in full for the first time in §2.3 | `scene/marks.test.ts:854`, `:1058`, `:1340`; `drawer/Conversation.test.tsx:281` (prose is prose, not a `<pre>` wall) | sans for prose, mono for figures, tabular numerals for anything compared down a column |
| **law 12** | prd-03 | `panels/fleet/index.test.tsx:515`, `:575`, `:740` | honest gaps: `—` plus a reason, never a fake zero |
| **the legibility floor** | prd-09 operator ruling (2026-08-03) | `theme/legibility.test.ts:117` "names no text-ice class or arbitrary hex dimmer than ice-400, allowlist aside" | no text dimmer than `ice-400` (5.1:1); a self-policing two-entry allowlist covers the two `aria-hidden` glyphs, and a stale entry fails the suite; `scene/` is excluded by its own fence |
| **the tissue fence** | prd-10 rulings 5, 11, 12 | `scene/marks.test.ts:3124` "the tissue accent appears only in tissue draws"; `scene/palette.test.ts:226-286` (OKLCH angle laws) | tissue (OKLCH H 295.5) is scene-only organic material — never ink, never chrome, never status — and it must actually be spent |
| **the role/form split** | prd-07 ruling 2 | `docs/design-notes/node-role-shape-split.md` — "the tests kept passing while the picture was redrawn underneath them" | laws are written in roles (`MarkRole`, ~60 members); form is free; a scene-art PRD must be written in roles |
| **the variation permission table** | prd-07 ruling 4 | `scene/variation.test.ts:47` "the channel table is law, not commentary" | a channel may vary only if it carries nothing; the three encoding channels (radial, hue, width) are locked |
| **the persistence laws** | prd-10 rulings 13–16 | by construction in `scene/retire.ts` — the four-stage machine: tension 150 ms → withdraw 800 ms → settle 450 ms → persistent ∞, one channel per stage | the network persists; completion is transformation, not removal; density is managed by hierarchy, never deletion; HIDE FINISHED is load-bearing |
| **the glance protocol** | prd-03 ruling 25 + prd-04 ruling 1 (the layman bar); #158 open | an operator act with a real lay viewer — fixtures on keys 1/2/3; deliberately not automatable | 3-second GLANCE / PATHOLOGY / 30-second SCENE with no legend; every FAIL becomes an affordance or the mark is CUT |
| **"no new hue"** | prd-13 r1 + r12, prd-14 r1, prd-27 r5, prd-28 r5, #192, #272 | restated in six independent rulings — the most-repeated constraint in the record | the six status hues are the whole vocabulary; nothing joins them |
| **the amendment process** | six observed precedents; prd-10 ruling 8 | the law tests themselves — #218 makes them a protected class | ruling + design note + test restated, and laws are restated stronger, never weakened — §2.4 |

### 2.1 · law 9a in full — the hue table

Six status hues, each owning exactly one meaning. Using one of them for anything else
is the single colour-law violation the design cannot absorb.

| hue | token | hex | meaning |
| --- | --- | --- | --- |
| calm | `--color-calm` | `#b3c6de` | structure's bright end — `ice-200` duplicated, not a seventh hue |
| working | `--color-working` | `#40d98c` | productive: the lane is getting on with it |
| done | `--color-done` | `#2e9d74` | the same green, dimmer: it got on with it, and stopped |
| waiting-benign | `--color-waiting-benign` | `#d9a441` | blocked on a human, nobody summoned — the amber family's muted end |
| needs-you | `--color-needs-you` | `#ffc857` | the incandescent end of amber: a human must act |
| broken | `--color-broken` | `#ff3d68` | dead — red only ever means dead, anywhere in the instrument |
| notice | `--color-notice` | `#4deaff` | something changed; nobody is needed yet |
| necrotic | `--color-necrotic` | `#4a5266` | a frozen lane's thread — a luminance, not a seventh hue; the corpse is grey, the alarm is red |

IDLE and UNKNOWN deliberately have no token of their own: they are `ice-400` and
`ice-600`, because nothing-to-say is structure and a lane the log has never mentioned
must not borrow the confidence a hue would give it.

### 2.2 · law 9b in full — the band

Four numbers, all in `scene/salience.ts`, and none of them a tuning knob:

- `RECEDE = 0.30` — what every other lane drops to under a spotlight
- `CALM_CEILING = 0.78` — the luminance every non-alarm mark is capped under
- `ALARM_FLOOR = 0.84` — the luminance a summons's brightest mark must clear
- `CALM_FLOOR = 0.15` — the floor under a living thread on a calm fleet

Since prd-04 dropped hue exclusivity, the six-hundredths gap between `CALM_CEILING`
and `ALARM_FLOOR` **is** the salience mechanism, and it is never spent — not on
ambient prettiness, not on vibrancy, not on a theme. `palette-vibrancy-dials.md`
states the price: spending any of it "would buy vibrancy with the one property the
instrument cannot lose." BROKEN is exempt from `ALARM_FLOOR` by ruling — `#ff3d68`
pushed to 0.84 is pink and has stopped meaning dead — and buys its dominance the
three other ways the grammar allows: the spotlight, the only cartouche, and exemption
from every fade. The band's one amendment (prd-10 ruling 4, the tip glow) was
stricter in three clauses and laxer in exactly one number (`TIP_CEILING = 0.81`,
still below the floor the alarms own) — the template every future amendment answers to.

### 2.3 · law 11, stated in full for the first time

Until this document, law 11 has only ever been cited — `architecture.md:528` and the
law tests name it; no document states it. It is:

**Sans for prose. Mono for figures. Tabular numerals for anything a reader could
compare down a column.**

The rule is mechanical, not aesthetic: if two values could be compared down a column
— counts, branches, shas, ids, timestamps, durations — they are data, they are mono,
and they are tabular. Prose renders in the sans face because a wall of monospace is
the loudest "this is for machines" signal a panel can send. The `figures` utility
(`theme/theme.css`) is the law's one-class enforcement; §3 names its sibling.

### 2.4 · the amendment process

Three parts, observed across six precedents:

1. a new PRD ruling that **names the ruling it amends**, with the new bounds as numbers;
2. a design note in `docs/design-notes/` cited from the code comment;
3. the law test restated — **stronger, never weakened** (prd-10 ruling 8).

Amendments append under dated headings, out of numeric order (the prd-13 r12/r13
precedent), and superseded reasoning stays in the text (prd-14 ruling 2: "the
reasoning is kept here because it is the substance"). This charter follows the same
process: it is amended by PR, and its pending rulings ride their owning PRDs.

## 3 · the typography through-line

Ground truth first. The named typefaces have never shipped: `--font-sans` and
`--font-mono` name Inter and JetBrains Mono, but nothing loads them — no
`@font-face`, no `<link>`, no fontsource dependency — so the instrument has always
rendered in Segoe UI and Consolas on Windows, SF on a Mac. There is no type ramp: 239
sizing sites, mode `text-[10px]` (×102), ceiling `text-sm` (14 px), zero rem — browser
font preferences are ignored entirely. The only heading style is one copy-pasted
string. Everything in this section is **normative on merge** — additive, amending
nothing:

- **The faces finally load, self-hosted.** `@fontsource-variable/inter` and
  `@fontsource-variable/jetbrains-mono`, imported at the app entry. A localhost-only
  instrument never reaches a CDN. The canvas `FONT` record (`scene/paint.ts:576`),
  which today diverges from the tokens (omits Inter, ranks JetBrains Mono last), is
  aligned to them.
- **Fonts and durations get mirror tests.** `palette.test.ts` already pins the canvas
  palette by parsing `theme.css` off disk; the same mechanism is applied to the font
  stacks and the `--duration-*` tokens. Today `--duration-settle`/`--duration-breath`
  have comment-only TS copies (`scene/geometry/scale.ts:210`, `scene/marks/frame.ts:81`)
  and `attention.css:52` references `--duration-age-pulse-seam`, which does not exist
  and silently falls back to 6800 ms — precisely the drift a mirror test refuses.
- **A rem-based ramp as `--text-*` tokens, in two named registers.**
  - _reading_ — conversation, tooltips, prose: floor 0.75rem (12 px-eq), body
    0.8125rem (13 px-eq).
  - _instrument_ — tables, trace, figures: 0.625rem (10 px-eq) legal on data-dense
    surfaces; 0.5625rem (9 px-eq) is the absolute floor, for `aria-hidden` ornament
    only.

  Exact values are to be tuned in the artifact conversation; **the structure, the
  units and the floors are charter law.** Tokens only: the `text-xs`-versus-
  `text-[12px]` class of drift — the same 12 px spelled two ways across 47 sites —
  becomes illegal.
- **The heading utility.** The idiom `text-[10px] font-semibold uppercase
  tracking-[0.2em] text-ice-400` — the app's only heading style, copy-pasted across
  the Conversation, Trace and Activity headers — becomes one named utility.
- **The two mono registers get names.** _figures_ is the existing utility (mono +
  tabular-nums, 39 files — the widest convention in the app); _code-voice_ is bare
  `font-mono` for tool names, results and transcript lines. The distinction is real
  in practice and has never been documented until now.

## 4 · the colour through-line

Normative on merge — additive, amending nothing:

- **Role tokens.** A semantic layer — `--surface-*`, `--ink-*`, `--line-*` — mapped
  from the ice ramp, so every consumer names a role, never a step. This is the
  machinery two themes require, and dark remains the source of truth: the role layer
  is derived from the dark ramp, not beside it.
- **Alias retirement.** The six dead aliases (`--color-void`, `--color-void-raised`,
  `--color-void-line`, `--color-neon-cyan`, `--color-neon-amber`,
  `--color-neon-magenta`) and their glow companions (`glow-cyan`, `glow-magenta`,
  `glow-amber`, `text-glow-cyan`) have zero call sites and are removed.
- **The last unpinned hexes get mirrors.** `panels/attention/useTabSignal.ts:25-28`
  hardcodes `FALLBACK_HUE` (`#ffc857`, `#ff3d68`); it joins the mirror suite.
- **Contrast becomes arithmetic.** The documented ratios — 5.1:1 at the `ice-400`
  floor, 3.3:1 and 2.4:1 below it — are prose in a `theme.css` comment today; no
  WCAG arithmetic exists anywhere in the repo. A contrast law computes them from the
  tokens, per theme, so the floor is a calculation rather than a claim.

> **Pending ruling — owned by the scene PRD.** _The ambient layer._ A new bounded
> channel family — depth washes, iridescence, texture, environmental tint — legalised
> through the variation-table device: a channel is granted only if it **carries
> nothing**, each grant has a stated bound, and an explicit **"ambient never means"**
> law accompanies the family. The tissue fence is unchanged; "no new **semantic**
> hue" is preserved exactly.
>
> **Ruled 2026-08-15 (prd-33):** the family is granted on exactly those terms —
> every ambient channel carries nothing, each grant states its bound in the
> variation table, and the "ambient never means" law ships with it (a rigged
> correlation between an ambient channel and a lane's state must turn the suite
> red).

> **Pending ruling — owned by the scene PRD.** _Ceilings raised._ Vibrancy rises only
> via the lawful recipe of `palette-vibrancy-dials.md`: chroma (`ACTIVITY_TINT`) and
> the floor (`CALM_BODY_FLOOR`). The 0.78/0.84 band does not move — §2.2 is the
> reason.

> **Pending ruling — owned by the legibility PRD.** _Light-mode severity and the
> band._ The 9b band is luminance-directional and inverts on light ground: "brighter
> than the calm world" cannot mean the same thing on white. Severity in light mode is
> carried by enclosure, weight and saturation plus a per-theme re-derived band —
> never by pretending brightness still means what it meant on the void. Canvas needs
> a theme-aware palette path (`scene/palette.ts` becomes per-theme tables; the colour
> mirror test doubles). The user switch itself is chrome, not status: a persisted
> preference defaulting to `prefers-color-scheme`.
>
> **Ruled 2026-08-15 (prd-32 ruling 7):** the light ground is **warm off-white, not
> clinical white**, with deep plum-grey inks and low-contrast hairlines — an eye that
> reads an instrument for hours is not served by maximum contrast, and the warm ground
> is what gives the category family below a material to sit against. BROKEN gains a
> cartouche and weight where on the void it gained luminance.

> **Pending ruling — owned by the legibility PRD.** _A bounded category family._
> Proposed 2026-08-15 and **ruled the same day (prd-32 ruling 8)**, recorded here
> because it amends §2's most-repeated constraint. Beside the six status hues — which
> remain the entire vocabulary of *state* — a small, low-chroma **category** family
> lands for *kind of work*, extended from the tissue accent (OKLCH H ≈ 295.5) so it
> reads as the organism's own material rather than as decoration. **"No new semantic
> hue" is preserved exactly**: category carries kind, never state.
>
> Five caps, each a number a law test holds: chroma ceiling well below every status
> hue · **no glow, ever** · **never above `CALM_CEILING`** · measured angular clearance
> from `--color-notice` · **greyscale survival** (law 9 restated for the family). On
> the scene it may ride only the thread's *material* — sheath, nodes, banding — never
> its living hue (prd-33 ruling 6).

## 5 · the motion through-line

Law 10 restated. **Five** closed classes (`scene/motion.ts:49`); nothing
in the picture may move outside one of them:

| class | what moves | budget |
| --- | --- | --- |
| ambient | the root-mass breath, idle life | 4–8 s period, ≤3% amplitude, unlimited |
| event | pulse travel, arrival flare, alarm throb | 400–600 ms; ≤7 concurrent, measured rather than chosen (prd-33 ruling 10; was ≤5 on Pylyshyn & Storm's tracking limit); alarms exempt |
| structural | a lane appearing, reflowing, disconnecting | ~800 ms critically damped (k=170); ≤2, staggered |
| dissolution | matter returning: composting, absorption | ≤240 pooled motes; luminance-only fade; typed `DissolutionCause` |
| growth | a thread growing in, continuous and gentle across many | its own budget, never structural's; typed `GROWTH_CAUSES` (prd-33 ruling 9) |

Above them sits the ALARM throb — an aging summons slows from 1200 ms to 2600 ms —
and beneath them the degradation ladder, which substitutes rather than stops:
`reduced` follows WCAG 2.3.3's split (drop travel and scale, keep colour and
opacity — a static bright dot replaces the WAITING throb); `paused` stops everything
automatic, except that structural motion settles first, because freezing it half-way
would show a topology that does not exist.

> **Pending ruling — owned by the scene PRD.** _The growth question._ Organic thread
> growth either lives inside structural's critically-damped envelope or becomes a
> fifth class — and the set opens only the way prd-10 ruling 10 opened it for
> dissolution: a typed cause so a sixth cannot be smuggled in, hard caps stated as
> numbers, every older cap untouched.
>
> **Ruled 2026-08-15 (prd-33 ruling 9): growth is the fifth class**, with its own
> budget rather than borrowing structural's — its character is opposite (continuous
> and gentle across many threads, where structural is discrete and settling), and it
> opens the set through prd-10 ruling 10's template exactly.

> **Pending ruling — owned by the scene PRD.** _The event and structural caps._
> **Ruled 2026-08-15 (prd-33 ruling 10):** the caps rise, under two conditions that
> keep the multiple-object-tracking research honoured. **The new numbers are derived
> from measurement** — the actual distribution of concurrent events in recorded
> sessions — rather than chosen by appetite; and **the alarm class is exempt**, so a
> death is visible at any density. The original cap protected a viewer's ability to
> see the one thing that mattered; priority achieves that where scarcity did.
> Ambient motion remains uncapped, as it always was.

## 6 · the interaction through-line

Normative on merge:

- **One hover-disclosure vocabulary.** Today there are three components in flight —
  #190's `MarkHoverCard`, #192's STATE hover card, #273's loupe read-out — above ~85
  native `title=` sites in 26 files that are keyboard-inaccessible, touch-invisible
  and OS-delayed. The charter rules one vocabulary, built on prd-27 ruling 5's
  label/why/remedy triple: three strings per condition, assembled once, so every
  surface says a condition identically, and unknown must name what is missing. Cite
  prd-27 ruling 5, not #192's text — the issue is partially superseded. The build
  rides the tooltip PRD; the "one vocabulary, not three" ruling binds now.
- **A global `:focus-visible` floor.** One token, and never a status hue. Today
  focus is hand-rolled at 18 sites in three idioms, and
  `panels/collisions/index.tsx:76` wears `ring-needs-you` — a status hue as a focus
  colour is exactly the law-9a smell the floor removes.
- **Keyboard reachability for every disclosure.** Whatever hover discloses, focus
  discloses. No pointer-only meaning anywhere in the instrument.

## 7 · the conversation and trace through-line

Normative on merge:

- **One kind→lightness module.** Three uncoordinated maps encode the same sentence
  today — `trace/glyphs.tsx`'s `KIND_CLASS`, `drawer/Activity.tsx`'s `KIND_CLASS`,
  and `drawer/Conversation.tsx`'s inline version — all saying _a kind is not a
  status: lightness only, never hue_. They unify into one module, so the sentence is
  written once.
- **The bracketing vocabulary is reserved, and its law shape pre-stated.** The
  conversation PRD owns the design; the charter fixes what any design must satisfy.
  Role chrome — brackets, gutters, rules — is **structure, drawn in the ice
  register**. Kind dispatches before role, the existing deliberate order (a session
  log records tool results on user lines). `data-role` is the hook, and it already
  exists (`<li data-testid="turn" data-role={role}>`). Prompts may carry the one
  existing notice accent — the cyan `›`, today the drawer's only status-hue use —
  and never a new hue.

## 8 · the disposition table

Every law in §2, dispositioned. AMEND meant a pending ruling — proposed and owned
here, decided in the owning PRD; all four were **ruled 2026-08-15** (prd-32
rulings 7 and 8, prd-33 rulings 9 and 10), and each is recorded inline where it
lands, in §4 and §5.

| law | disposition |
| --- | --- |
| law 9 | **KEEP** — unchanged |
| law 9a | **KEEP** — the ambient pending ruling (scene PRD) must preserve "no new semantic hue" exactly |
| law 9b | **KEEP** — the dark band's four numbers do not move; the light-band pending ruling (legibility PRD) re-derives a band per theme beside it |
| the CALM_FLOOR law | **KEEP** |
| law 10 | **KEEP** — growth became the fifth class and the event cap rose to a measured 7 (prd-33 rulings 9 and 10, 2026-08-15), both via prd-10 r10's template; the numbers are in §2 and §5 |
| law 11 | **KEEP** — stated in full for the first time in §2.3 |
| law 12 | **KEEP** |
| the legibility floor | **KEEP** — the contrast-arithmetic addition (§4) turns its numbers from prose into computation, per theme |
| the tissue fence | **KEEP** — explicitly unchanged by the ambient layer |
| the role/form split | **KEEP** — the scene PRD must be written in roles |
| the variation permission table | **KEEP** as the mechanism — the ambient pending ruling (scene PRD) would add bounded rows, granted only to channels that carry nothing |
| the persistence laws | **KEEP** |
| the glance protocol | **KEEP** — the #158 re-run is booked into the scene PRD's gate; see below |
| "no new hue" | **KEEP** — the ambient pending ruling restates it as "no new **semantic** hue", which is stronger about meaning, not weaker about colour |
| the amendment process | **KEEP** — this charter is itself subject to it |

ADD — the charter's own additive rulings, binding on merge, amending nothing: the
loaded faces and the font/duration mirrors (§3) · the `--text-*` ramp structure with
two named registers (§3) · the heading utility (§3) · the named mono registers (§3) ·
role tokens (§4) · alias retirement and the `FALLBACK_HUE` pin (§4) · contrast as
arithmetic (§4) · one hover-disclosure vocabulary and the `:focus-visible` floor
(§6) · the kind→lightness module (§7) · the bracketing reservation (§7).

Two tensions were named here and **both have since resolved** (2026-08-24):

1. **prd-14 ruling 1 was under contradictory amendment by PR #431.** Its ruling 5
   (the lane canvas is _n_ organisms — amends the metaphor) sat against its ruling 8
   (the observability frame scene is one organism via the `scene/` renderer — asked
   for full reversal). **Resolved by the operator's coexist-by-surface ruling
   (2026-08-13, recorded at `docs/prds/done/prd-33-the-living-scene.md`): different
   surfaces, different pictures, both lawful** — the lab's arms strip is _n_ small
   organisms; the frame's scene is one organism through `scene/`. prd-14 was itself
   ruled 2026-08-24 (ruling 5, the persistence seam). PR #431 is dead-repo
   provenance, and prd-28's paper did not survive the re-upload: the lab's design
   authority is its 2026-08-24 re-founding, not that review.
   **Note (2026-09-08, prd-53 wave 5):** that re-founding resolves to the shared artifact
   *The Lab Workspace*, which describes itself as proposed and unblessed; the lab's paper is
   now prd-53 (`docs/prds/prd-53-the-lab.md`) and its design authority prd-53's companion
   specification artifact, cited from the PRD. prd-28's number is retired, never reused.
2. **prd-21 was cited but not on main.** It landed and shipped — `docs/prds/done/
   prd-21-scrub-bar.md`, closed out 2026-08-13. The prohibition on leaning on its
   text is lifted; prd-13 ruling 1's standing refusal (TIDE is never a panel) binds
   as it always did.

One standing booking, still owed: the **glance re-run** — never re-run since prd-10 —
is part of the scene PRD's gate (prd-33 wave 0). It is an operator act with a real lay
viewer, booked, not skipped, and not dispatchable to an agent. Its old tracker number
(#158) died with the repo; the obligation lives in prd-33's own gate text.

## 9 · process

- **The artifact restates, never rules.** Where the artifact and this charter
  disagree, the charter is right and the artifact is a rendering bug.
- **Forms are decided in the owning PRD, and reviewed by the team.** The visual
  companion renders what the charter and the PRDs decide; charter PRs record what
  survives review. The charter changes by pull request, or it does not change.
- **Blessing happens at design sync.** A pending ruling stays pending until its
  owning PRD's ruling is blessed there.
- **Future amendments follow §2.4**: a ruling that names what it amends with numbers,
  a design note cited from the code, and the law test restated — stronger, never
  weakened.
