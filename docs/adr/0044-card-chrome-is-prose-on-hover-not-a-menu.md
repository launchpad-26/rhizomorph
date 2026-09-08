# 0044. Card chrome is prose on hover, not a menu

- **Status:** accepted (prd-30 S1 acceptance; recorded on the build, #221)
- **Date:** 2026-09-09

## Context and Problem Statement

prd-30 S1 asks for a law asserting that "no other directory renders card
chrome". The law that shipped with the card is narrower than that sentence: it
matches one string, `data-disclosure-card`, so it catches a surface that *copies*
this card and says nothing about a surface that grows *a different* one — which
is the failure prd-30 exists to prevent.

Widening it needs a definition of card chrome. The obvious one — a positioned
panel that opens on hover or focus — catches `tide/ChapterMarks.tsx`'s
`MarkHoverCard`, which is hover- and focus-triggered and positioned, and which
prd-30's own text lists as an idiom to retire. But its content is a list of
`<button>` rows that seek to a timestamp. `DisclosureContent` is
`{label, why{reason, evidence{fact, elapsedMs}}, remedy}`: there is nowhere to
put N action rows, and `disclosureLines` throws without a fact and an age a menu
does not have. Re-seating it would delete click-to-seek.

So the law must either name `tide/` as an exception — recreating the allowlist
#221 was written to end — or define card chrome so that a menu is not one.

## Considered Options

- **Card chrome is prose on hover; a panel containing controls is a menu.**
- **Name `tide/` in an exception list** on the widened law.
- **Give `DisclosureContent` an actions arm** and re-seat the menu onto it.

## Decision Outcome

**Prose, not controls, as the third clause of the definition.** The line is
principled rather than convenient: one hover vocabulary for *explaining* is what
prd-30 ruled, and prd-27 ruling 5's label/why/remedy triple is a vocabulary for
conditions. A list of places to jump to is not a condition and has no why and no
remedy. Drawing the line at content also makes the law checkable by the same
kind of scanner the directory already uses, and it names nothing — so it stays
true for a component nobody has written yet.

*An exception list* lost because it is the allowlist under another name, and
because the next hover panel someone adds in `tide/` would inherit the exemption
without anyone deciding it should. #220 shipped exactly that defect at directory
scale and it took a verify pass to find.

*An actions arm on the card* lost as scope and as design. It is a re-design of
the vocabulary, not a re-seat; it would put a control inside a component whose
whole discipline is that it renders `disclosureLines` and composes nothing; and
the teach affordance is already the one control the card carries, deliberately.

## Consequences

- Good: the widened law names nothing and needs no exception list, so it keeps
  meaning what it says as the tree changes.
- Good: it draws a line an author can apply while writing — *am I showing words
  or things to click?* — rather than one that requires reading a list.
- Bad: a panel that mixes prose and one control reads as a menu to this scanner
  and escapes the law. That is a real hole; it is narrower than the one it
  replaces, and a mixed panel is a design smell worth catching in review anyway.
- Bad: `MarkHoverCard` keeps its own chrome and its own open delay, so the
  instrument still has two hover panels with different timings. prd-30's "same
  answer whichever pixel is under the pointer" is therefore met for explanations
  and not for the timeline's menu.
- Bad: the scanner reasons about markup, so a panel assembled through a helper
  it cannot see would be missed. Every law in this directory shares that limit.
