# 0047. A control that explains its own unavailability is `aria-disabled`, not `disabled`

- **Status:** accepted (prd-30 wave 4 grooming ruling; recorded on the build, #389)
- **Date:** 2026-09-10

## Context and Problem Statement

Charter §6 is binding: whatever hover discloses, focus discloses. prd-30 retires
every native `title=` in the instrument's own surfaces in favour of
`disclosure/Disclosure.tsx`, which opens on hover, on focus and on tap out of one
state machine.

Three of the last twelve tooltips sat on `disabled` buttons, and their text
existed precisely to explain the disablement:

| site | unavailable when | string |
|---|---|---|
| `packages/web/src/replay/index.tsx` — replay-birth | `sessions.length === 0` | No recorded sessions yet |
| `packages/web/src/replay/index.tsx` — Play | `!isReplaying` | Select a session first to enable playback |
| `packages/web/src/scene/SceneView.tsx` — `MotionControl` | `stilled` | Motion is stilled in settings — the control lives there |

A `disabled` button is removed from the tab order and suppresses pointer events.
So the explanation for a control's own unavailability is the one explanation a
keyboard user can never reach, and porting these strings onto a still-`disabled`
button would have shipped three pointer-only disclosures — prd-30 S1's *"a
pointer-only disclosure"* failure, arrived at by the sweep that was supposed to
end it.

`Disclosure` has no `disabled` handling. Its inline trigger is a bare
`<span role="note" tabIndex={0}>`.

## Considered Options

- **Keep `disabled`**, and accept that the reason is pointer-only.
- **Teach `Disclosure` a `disabled` mode**, so the component handles it.
- **Swap to `aria-disabled` with a guard inside the handler.**

## Decision Outcome

**Chosen: `aria-disabled` with a guarded handler**, scoped to exactly the three
controls above.

*Keeping `disabled`* loses on its own terms: it is the failure prd-30 exists to
end, and it would have been introduced by prd-30's own final sweep.

*Teaching `Disclosure` a `disabled` mode* loses because it puts the workaround in
the shared component, where every future caller inherits a second code path.
`Disclosure`'s entire claim is that hover and focus are not two paths asserted to
agree — `open` is one boolean and there is one `<DisclosureCard>` in the tree, so
a keyboard user *cannot* be shown less than a mouse user because there is no
second render to be shown from. A `disabled` arm is exactly the second path that
claim forbids, added for three call sites.

*`aria-disabled`* keeps the control focusable, so the existing single path reaches
it with no new component behaviour, and confines the change to the three controls
that need it. `app/Nav.tsx`'s `DisabledNavLink` already established
`aria-disabled` beside a disclosure card for the unavailable nav item (#220); this
extends the same idiom from a dead link to a live button.

**This is not a package-wide migration.** `recordings/RenameControl.tsx`,
`lab/launch/`, `tide/TideDock.tsx`, `replay/RotateButton.tsx` and the playback
speed buttons all keep `disabled`: none of them carries text explaining its own
unavailability, which is the whole trigger for this record.

## Consequences

**Good.** The reason a control is unavailable is reachable by pointer and by
keyboard, from the same card, with no second render and no new component mode.

**Bad, and the reason this record exists.** An `aria-disabled` button is a *real*
button to the browser: it fires `onClick` on click, on Enter and on Space alike.
Guarding only the pointer path — `onMouseDown`, or `pointer-events-none` — leaves
a keyboard user able to invoke an action the surface says is unavailable, which is
strictly worse than the `disabled` it replaced. **The guard therefore lives inside
the handler body, never on the event**, and it is hand-written behaviour that no
type can enforce. A future author who adds a fourth such control without the guard
ships an invokable "unavailable" button, and nothing will fail.

**Bad: the guard is often unobservable, so it is easy to test vacuously.** Measured
on this build (#389). Two of the three controls' underlying actions already no-op
when unavailable — `replayBirth` returns early because `pickRichestSession([])` is
`null`, and `playback.play()` returns early because the live range is degenerate
(`start >= end`) — and `SceneView` passes `paused={paused || stilled}`, which masks
the third at the scene level. Deleting **both** replay guards leaves
`replay/index.test.tsx` green at 29/29. A test written through those surfaces
proves the promise, not the guard. `MotionControl` is exported for
`SceneView.test.tsx` alone so that one guard can be driven directly with a spy,
where its removal does go red; that export exists for this reason and no other.

**Bad: `disabled:` Tailwind variants stop matching.** The variant follows the
attribute, so `disabled:opacity-50` must become `aria-disabled:opacity-50` or the
control silently stops *looking* unavailable while still being it. Two class
strings in `replay/index.tsx` needed this.

**Bad: jest-dom's `toBeDisabled()` no longer matches these controls.** It reads the
`disabled` attribute and does not consider `aria-disabled`. Four existing
assertions moved to `toHaveAttribute('aria-disabled', 'true')` on this build.
