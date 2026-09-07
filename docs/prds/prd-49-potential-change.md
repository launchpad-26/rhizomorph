# prd-49 — potential change

> **Status:** **BLESSED** — ciaran-slow, 2026-09-01, in session. Milestone `prd49`. Holds one
> issue, moved out of `prd47` at its closeout: [#190][i190]. This is not a programme of work.
> It is a conditional verdict given a place to live, so that the condition is watched rather
> than remembered.

## Problem

prd-47 shipped all three of its waves and answered its fourth ruling **NO-GO** on 2026-09-01:
the display list does not get a free-list, because the variance it was meant to fix was not
there to fix. That answer is **conditional on the scale the instrument renders**, and a
conditional verdict left inside a finished PRD reads as a settled one. The milestone shows zero
open issues; the condition survives only as somebody's memory of why the No was a No, and the
person who has that memory is not the person who will next look at frame cost.

## Evidence

`research/2026-08-28-variance-attribution.md` (commit `74007f3`). [#190][i190] carries the
trigger and the re-measurement recipe in full; this is the short form.

- At the scale the app renders today — the 20-lane fixture — GC is **0.74 %** of main-thread
  animation-frame time, and **0 of 764** frames missed the 16.67 ms budget. There is no tail to
  attribute.
- prd-47 ruling 4's own falsifier was run and **not met**: worst/median *rose* under forced
  out-of-band collection, 1.25x → 1.66x, rather than collapsing.
- The browser measurement never reached the regime where a tail exists. The shipped fixture is
  21 lanes; the harness cell that shows one is 60x3 = **180 threads**, where the *median* frame
  is 106.7 % of a 16.67 ms budget. The halfway cell, 30x3 = 90 threads, is already at 49.8 %.
- The trace was taken against the vite dev server, which allocates more than a production build
  and therefore **over-stated** GC. The No is if anything stronger than the number that produced
  it — but it was measured on the wrong build, and that is a known defect in the evidence.

## Success

The condition is a tripwire in the backlog rather than a fact in someone's head. **Not met
while** the NO-GO can be read as unconditional, or while the trigger has tripped and nothing has
re-asked the question.

## Non-goals

- **Building the pooling.** It is not groomed, and it does not become groomed by this PRD
  existing. The measurement already says it would be the wrong instrument in the regime that
  would trip the trigger: at 180 threads the **median** frame is over budget, not the occasional
  one, and a free-list does not fix a median.
- **Re-opening prd-47.** Its rulings stand as written and its citations keep resolving. This PRD
  holds the residual, not the record.
- **`scene/marks/`.** That is prd-33's fence, and prd-47's sequencing already said so. Nothing
  here reaches it.

## Rulings

## Ruling 1 — the verdict is carried as a tripwire, not as a memory

prd-47 ruling 4's NO-GO stands, and it stands *with its condition attached*. The condition lives
on [#190][i190] as a stated trigger — a real session or shipped fixture rendering more than ~90
threads, **or** the model floor's 30x3 cell crossing ~60 % of budget on the reference box — and
the issue stays open, `Later` / `Low`, until one of those is observed. An issue that can only be
closed by the trigger being ruled irrelevant is the cheapest form this can take; a paragraph in a
closed PRD is the most expensive.

> **Amendment — what the trigger refers to once the scene composes colonies** (operator ruling,
> Lachlan Kelliher, 2026-09-07). The original reasoning above stands unchanged; this settles what
> its two clauses *point at* now that prd-52 makes "the 30x3 cell" ambiguous. Both clauses were
> written when the only way to reach 90 threads was three independent single-colony layouts summed
> in a test. prd-52 changes both halves of that, so left alone this trigger would either fire on
> its own test data or silently start reading a different number.
>
> - **Clause 2 follows the composed cell, not the summed one.** Once `layoutWorld` exists, "the
>   model floor's 30x3 cell" means the cell measured *through composition* — the number the product
>   actually renders. **The ~60 % threshold does not survive that change unexamined:** it was
>   calibrated against the summed reading of 49.8 %, and the composed cell must be higher, because
>   composition adds placement, a union camera fit and cross-colony marks that the sum charges
>   nothing for. So the threshold is **re-derived from the first composed measurement** (prd-52
>   wave 5) and recorded here in a further amendment. Until that measurement exists, clause 2 is
>   **suspended rather than tripped** — a threshold read against the wrong baseline is not a
>   signal, and firing on it would oblige ruling 2's work on no evidence.
> - **Clause 1 is not tripped by a synthetic fixture.** A multi-colony demo fixture is test-only
>   and does not ship as a selectable `StreamSource`, so it cannot satisfy "a real session or
>   shipped fixture." The clause keeps meaning *a real fleet got big*, which is the fact it was
>   written to catch — not *we added a demo*. This also keeps prd-37 ruling 6 intact: a solo user
>   is shown no team scaffolding, because there is none to select.
>
> Ruling 2 is untouched and still binds whenever a clause does trip.

## Ruling 2 — when it trips, the first act is a re-measurement, not a build

The trigger re-asks the question; it does not answer it. The order on [#190][i190] binds: re-run
the forced-collection cells still in `scene/perf.test.ts`, re-record the trace **against a
production build** this time, and only then — if the *tail* rather than the median is the binding
constraint and GC is in the frames — groom the pooling, with prd-33's cross-PRD agreement
recorded on the issue first. Reaching for the free-list on the strength of the trigger alone
would be building against the one regime the evidence says it does not help.

## Sequencing

No waves. One issue, [#190][i190], `Later` / `Low` / `Backlog`, dispatchable by nobody until its
trigger trips. When it does, ruling 2 is the order of work, and whatever it produces gets groomed
into waves then — against measurement that exists, which is the whole point of parking it here
rather than pre-writing them now.

## Open questions

- **Does a tail exist above ~90 threads on a production build?** Unmeasured. The only trace was
  a dev-server one at 20 lanes. Open, not ruled.
- **Is 90 threads a scale this product ever reaches?** The trigger is written so nobody has to
  answer that in advance. Open, not ruled.

[i190]: https://github.com/launchpad-26/rhizomorph/issues/190
