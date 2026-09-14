# prd-35 — the operator's hand: what you may change, and what you may not

> **Outcome:** shipped.
> **Kind: specifying** (`docs/prds/README.md`).
> The instrument has no settings surface at all — panel collapse and scene preferences hide in
> browser storage with no UI, and every operational choice (which repo, the telemetry env, the
> theme that does not yet exist) lives in a shell command or nowhere. Shipping as a desktop
> application (prd-34) makes that untenable: a tray daemon, notifications, a theme and
> launch-on-login are all preferences, and preferences need a home. **This PRD owns the
> configuration surface and, more importantly, the list of things that may never be configured.**
> Sequenced in stage 1 beside prd-32 — nearly every other PRD wants somewhere to put a switch.
> Decisions from `docs/design/ui-2.0-decisions.md` (D16, D36, D41, D42, D48).

## Problem

There is nowhere to change anything. The watched repo is a command-line argument; the telemetry
wiring is an env block you paste into a shell; panel collapse persists in `localStorage` under a
key no surface exposes; scene preferences likewise. Nothing is discoverable, nothing is
reviewable, and a person cannot see what they have configured because there is no place that
shows it.

That is survivable for a tool you launch from a terminal in a repo you already know. It is not
survivable for software someone installs: the moment there is a tray icon that can be told to
launch at login, a notification that can wake you, a theme that can be light or dark, and a
scene whose richness can be dialled down on a weak machine, the absence of a settings surface
stops being an omission and becomes the reason the product feels unfinished.

There is a second, subtler problem, and it is the one this PRD exists to solve properly.
**Settings menus are where honest products start lying.** The pattern is always the same:
someone finds a warning annoying, the warning earns a toggle, and now the software has a mode in
which it tells you everything is fine while it is not. This instrument's entire claim is that it
would rather be ugly than reassuring. A configuration surface without an explicit list of
non-negotiables is how that claim gets spent, one reasonable-sounding checkbox at a time.

## Evidence

- **No settings surface exists.** `packages/web/src/app/panelPrefs.ts` persists
  `rhizomorph.panelCollapsed.v1` and `rhizomorph.scenePrefs.v1` to `localStorage`; no component
  renders either as a control. There is no `/settings` route in `app/router.ts` — five routes,
  none of them configuration.
- **The theme switch has nowhere to live.** prd-32 ruling 4 requires a persisted, user-switchable
  theme defaulting to `prefers-color-scheme`, and its own open question asked where the switch
  sits. This PRD answers it.
- **prd-34 needs four toggles** it cannot place: close-to-tray, tray badge, notifications,
  launch-on-login — each of which the operator ruled must be toggleable.
- **prd-33 needs one**: named scene quality levels, so an art-piece scene stays usable on a
  machine that cannot hold its frame budget.
- **prd-37 needs the one that matters most**: the per-person sharing opt-in — facts always,
  words only if you share them. A privacy control with no surface is not a control.
- **The honesty laws already exist and are enforced** — law 12's gap voices, ruling 14's
  zero-with-evidence, prd-9 ruling 7's estimate flags, the simulated/real distinction — but
  nothing states that they are *not configurable*. Today that holds only because there is no
  settings surface to weaken them from.

## Success

1. Every preference the product has is visible in one place. **Not met while** a setting exists
   that a person can only change by editing storage, passing a flag, or editing a file.
2. The non-negotiables are enforced, not merely intended. **Not met while** a law test does not
   fail on a control that would let a person disable an honest-gap voice, the alarm band, the
   attention ladder, the zero-with-evidence rule, or the simulated/real distinction.
3. Configuration and verification are different places. **Not met while** `/connect` grows a
   control that changes something, or settings grows a diagnostic that claims something works.
4. A person can tell what they have changed. **Not met while** a modified setting is
   indistinguishable from a default.
5. Settings survive a restart and a repo change, correctly scoped. **Not met while** a per-repo
   preference leaks across repos, or a global preference resets when the watched repo changes.

## Non-goals

- **Not accounts, not sync, not a profile.** Preferences are local to the machine, as everything
  else in this instrument is. prd-37's identity declaration (display name and colour) lives here
  as a *field*, not as a login.
- **Not a plugin or theming system.** Two themes, named quality levels, and a fixed set of
  toggles — not a surface where a person invents their own palette. The category and status hues
  are law (prd-32 ruling 8, law 9a), not taste.
- **Not the first-run wizard.** prd-34 owns the guided path; this PRD owns the place it sends
  people to, and the two never render the same control twice (ruling 2).
- **Not a diagnostics surface.** `/connect` proves the chain; settings changes it.

**Rejected alternatives.** *Settings in the tray menu only* — splits configuration across two
places the moment a web-side preference (theme, density) exists, and makes it invisible to
anyone running the server without the shell. *Inline controls only, no settings page* — nothing
to survey; a person cannot answer "what have I changed?" without hunting every surface. *A
config file* — honest and scriptable, and it is exactly the interface a stranger installing an
app cannot use; the file may remain as an escape hatch, but it is not the answer.

## What already exists (do not rebuild)

`panelPrefs.ts` is the persistence idiom — keyed, versioned (`.v1`), read through a hook — and it
extends rather than being replaced. `capability-guidance.ts` is the precedent for copy living in
exactly one module so callers cannot re-grow their own wording. The honest-gap voice
(law 12: WHAT is missing → WHY it matters → the command that fixes it) is the register every
setting's explanation is written in.

## Rulings

## Ruling 1 — settings changes things, connect proves things, first-run walks you through both

Three surfaces, three jobs, no duplicated control. **Settings** is where a person changes the
watched repo, the theme, motion, density, scene quality, notifications, tray behaviour,
launch-on-login, their identity declaration and their sharing opt-in. **`/connect`** is where a
person sees whether the chain actually works — every link, its evidence, and the remedy when it
is broken; it renders no control that changes state. **First-run** (prd-34) is a guided path
*through* those two surfaces, driving them rather than reimplementing them.

The rule that keeps them honest: **if a control changes something, it lives in settings and
appears exactly once**. A surface that needs it links to it.

## Ruling 2 — the non-negotiables are a named list, and a law test enforces it

The following may never become a preference, and the reasons are not stylistic:

| never configurable | why |
|---|---|
| The alarm band and the attention ladder | The band is the mechanism by which a dying lane reaches a human. A "calmer alerts" mode is a mode in which the instrument stops doing its one job. |
| Honest-gap voices | A hidden warning is a claim that nothing is wrong. Law 12 exists because the absence of a flag reads as evidence of absence. |
| Estimate flags and cost provenance | "Show costs as exact" would make an estimate indistinguishable from a measurement. Dollars are vendored, flagged, or absent — never invented (prd-9 ruling 7). |
| Zero-with-evidence | "collisions: 0 — checked 47 branches" may never collapse into a hidden panel or a bare blank; those are different and weaker claims. |
| The simulated/real distinction | Demo chrome is not themeable, dismissible or hideable. A screenshot of simulated data must never be mistakable for telemetry. |

**A law test enumerates this list** and fails on a control, a preference key, or a rendered
toggle that would weaken any entry — the same structural posture the mutating-calls law takes:
a sixth exception fails and has to argue itself in a diff a reviewer reads.

## Ruling 3 — preferences are scoped, and the scope is visible

Three scopes, and a setting declares which it is: **machine** (theme, motion, density, scene
quality, tray, launch-on-login, notifications, identity), **repo** (watched repo, dock tab,
panel collapse, sharing opt-in), and **session** (nothing today — reserved so that a future
transient preference cannot silently become permanent). A repo-scoped preference does not leak
across repos when the watched repo changes; a machine-scoped one does not reset.

## Ruling 4 — a changed setting looks changed, and can be put back

Every control shows its default and whether it is currently overridden, and every group offers
"restore defaults" for its own scope. A person who has been fiddling can always answer *what did
I change?* — which is also what makes it safe to fiddle.

## Ruling 5 — motion and quality are health controls, not decoration

The scene's quality levels (prd-33) and the motion control are in settings because a person may
*need* them: a weaker machine, a migraine, a battery, an OS preference that goes further than
the app's default. The in-app motion control may go **beyond** the OS preference (to a full
still composition) but never **below** it — if the system asks for reduced motion, the app never
overrides that upward.

## The specification

### S1 — the settings surface

**What and why.** One place, reachable from the persistent nav (prd-32 ruling 10), grouped by
concern so a person can survey what they have changed.

**Groups, in order:**

1. **Appearance** — theme (dark · light · follow system) · density (comfortable · compact) ·
   scene quality (calm · rich · maximum).
2. **Motion** — follow system · reduced · still. Never below the OS request.
3. **Notifications** — per condition (needs a human · died · landed · spend threshold), plus the
   threshold value and quiet hours.
4. **Application** (desktop only) — close to tray · tray badge · launch on login · update
   channel.
5. **Repo** — the watched repo, with the concierge's picker (prd-20) reused, never reimplemented.
6. **Telemetry** — the env block for this instance, copyable, with the same same-process warning
   `/connect` uses.
7. **You** — display name and colour (prd-37's identity declaration), defaulting to the git
   identity already in the log.
8. **Sharing** — the per-person opt-in (prd-37): facts always; words only if shared. Stated in
   plain words, defaulting to facts-only.

**States.** *default* (nothing overridden) · *modified* (per-control marker plus a group-level
"restore defaults") · *unavailable* (a control that cannot apply in this context — desktop-only
groups in a browser, sharing when no team server is configured — renders **disabled with its
reason**, never hidden) · *error* (a setting that failed to persist says so and keeps the
in-memory value) · *replay* (settings remain usable; controls that would change live behaviour
are disabled with the reason) · *demo* (unchanged; demo mode is not a setting, it is a source).

**Data source.** `localStorage` via the `panelPrefs` idiom for web-side preferences; the shell's
own store for desktop-only ones (prd-34); `GET /api/meta` for the current repo and telemetry
instance. **No setting is inferred** — an unset preference reads as its default and says so.

**Interactions and keyboard path.** Reachable from nav; every control is a native form element
so it is keyboard-operable by default; group headings are landmarks; the one `:focus-visible`
token (prd-32) applies. `Escape` does nothing here — it is a page, not a dialog.

**What would make it wrong.** A control that changes something also existing on another surface;
a setting with no visible default; a disabled control with no stated reason; a preference that
silently changes scope; anything on ruling 2's list acquiring a toggle.

**Acceptance criteria.**
- Every persisted preference key in the codebase is rendered by exactly one control here (a test
  enumerates keys and asserts coverage).
- Ruling 2's law test fails on a rigged control for each of the five non-negotiables.
- Changing the theme updates `data-theme` and persists across reload; changing motion to *still*
  survives a reload and is not overridden by the OS setting going the other way.
- A repo-scoped preference set in repo A is absent in repo B and returns when A is watched again.
- Rendering in a browser (not the shell) shows the Application group disabled with its reason.

### S2 — the honesty law

**What and why.** Ruling 2 as executable law, so the list cannot be quietly extended.

**Mechanism.** A source-text law over the settings module and the preference registry: the set of
preference keys is enumerated in one place; any key matching a forbidden concern (an allowlist of
names plus a denylist of concerns) fails; and a positive test proves the law bites by rigging one
violation per entry. Same posture as `mutating-calls-law.test.ts`: exact enumeration, not "at
least".

**Acceptance.** Five rigged violations, five reds. The law names, in its own doc comment, why
each entry is on the list — so the next person to want the toggle reads the reason before the
rule.

## Sequencing (waves)

`packages/web/src/lab/` is prd-28's territory; no wave of this PRD enters it.

> **Note (2026-09-08, prd-53 wave 5):** prd-28's paper died in the 2026-08-19 deletion and its
> number is retired, never reused. The fence stands; the territory's owner is prd-53
> (`docs/prds/done/prd-53-the-lab.md`). The sentence above is kept as written — a number is an identity.

1. **Keystone:** the surface itself plus the preference registry and ruling 2's law — appearance,
   motion and density only, since those are the settings that exist to be set once prd-32 lands.
   Zero-claimant: a new route and a new directory.
2. Parallel, fenced apart: notifications and the Application group (**rides prd-34's shell**;
   disabled with reason until it exists) · the Repo and Telemetry groups (reuse the concierge and
   `/connect`'s existing copy) · scene quality (**rides prd-33**; the control lands here, the
   levels are prd-33's).
3. You and Sharing — the identity declaration and the opt-in (**rides prd-37**).

Unfiled work implied, described not numbered: the migration of `panelPrefs`' existing two keys
into the registry so nothing persists outside it.

## Open questions

- **Whether density is two levels or three** — comfortable/compact proposed; a third only if the
  dock's tables demand it. Open, not ruled.
- **Whether quiet hours are a schedule or a mute toggle** — a schedule is more useful and more to
  build. Open, not ruled.
- **Where the config-file escape hatch lands, if it survives** — a file that settings reads and
  writes, or a file that overrides settings. Open, not ruled.
- **Whether "restore defaults" is per group or also global** — per group is proposed as safer.
