# 0045. Parity is declared per file, because the render is transitive

- **Status:** accepted (prd-30 S1 acceptance; recorded on the build, #334)
- **Date:** 2026-09-09

## Context and Problem Statement

`app/title-residue-law.test.ts` pairs every shipped file that renders
`<Disclosure>` with a test that opens its card, so charter §6 — whatever hover
discloses, focus discloses — is proven per surface rather than asserted in a
build report. #220 shipped that pairing at **directory** granularity, arguing in
the law's own docstring that a per-file map would be "a second place to forget".

The granularity had a measured hole. `packages/web/src/lane-page/` holds four
adopting files; two were covered, so the law read the directory as proven.
#221's verify pass deleted `RunOutcome.tsx`'s `<Disclosure>` wrapper outright
and the full `lane-page/` and residue-law suite — 60 tests — stayed green. A law
that reports success over an unproven surface is the failure mode AGENTS.md
already records for `cmd_orphans`: a wrong pointer to a real check.

So the pairing must be per file. The question is how a per-file rule learns
which test covers which surface.

## Considered Options

- **A declared map**, checked in three directions by the law.
- **Infer from imports** — a test covers a surface if it imports it.
- **Infer from filenames** — `Foo.test.tsx` covers `Foo.tsx`.
- **Keep directory granularity** and accept the hole.

## Decision Outcome

**A declared map.** `PARITY_TEST` names, for each adopting surface, the test
that opens its card. The law asserts three things: every adopter is a key, every
named test exists and actually calls `discloseText`, and no key names a surface
that has stopped disclosing.

The docstring's objection is answered rather than ignored, and the answer is
that it conflated two different things. A map you can **forget to update** is
bad; a map the law **fails without** is not forgettable, because forgetting is
the loud state. A new adopter is red until it names its test.

*Inferring from imports* lost because the render is transitive.
`lane-page/LanePage.tsx` renders `<RunSpine>`, so `RunView.test.tsx` covers
`lane-page/RunSpine.tsx` while importing nothing from it. The rule would report
a false negative exactly where the coverage is real, and a law that cries wolf
on correct code is a law the next person weakens to get their PR through.

*Inferring from filenames* lost harder: `PageHeader.tsx` is covered by
`LanePage.test.tsx`, which shares no name with it. Three of the eighteen
mappings today are name-mismatched.

*Keeping directories* lost to the measurement above.

## Consequences

- Good: the hole is closed with a number on it — eighteen surfaces, each named,
  none certified by a neighbour.
- Good: adding a surface forces a decision about how it is proven, at the moment
  the surface is written rather than at review.
- Bad: the map is real maintenance. Moving or renaming a test file breaks the
  law until the key is updated — noisily, which is the trade, but it is still a
  second edit for a rename that would otherwise be one.
- Bad: an entry proves a test *opens some card*, not that it opens **that
  surface's** card. A test covering two surfaces satisfies both keys while
  exercising one. Narrowing that needs the test to name what it opened, which is
  a bigger change than this issue is; the map at least makes the claim visible
  and attributable where a directory could not.
- Bad: it is one more hand-maintained list in a repository that already treats
  those with suspicion. It earns its place only because the law fails without
  it — an entry nobody checks would be exactly the decoration this repo's own
  allowlist notes warn about.
