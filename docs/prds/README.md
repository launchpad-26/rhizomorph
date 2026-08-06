# Product Requirements Documents

A PRD says **what we are building, for whom, and how we will know it worked** —
before the building starts. It is not a spec, not a design doc, and not a
decision log.

`docs/prds/` holds PRDs still in flight. `docs/prds/done/` holds the shipped and
superseded ones.

## A note on what is already here

The 18 PRDs in this repo were written under an earlier convention, roughly
2026-07-30 to 2026-08-06. They are **ruling logs**: numbered
`## Ruling N — <verdict>` entries, each a decision with its rationale, amended
in place by later numbered rulings.

That format has real strengths and this standard keeps them. Every ruling is
dated and attributed; amendments are recorded as new rulings that name what they
change (*"Ruling 13 — the band is CUT (operator amendment, 2026-08-06)"*); and
they are genuinely read — ruling numbers are cited **688 times** from code
comments in `packages/*/src`.

**Those numbers are load-bearing. Never renumber a ruling.** A comment reading
`prd10 ruling 4` has no compiler to catch it if ruling 4 moves or changes
meaning.

What the old format lacks is the front half: measurable outcomes, explicit
non-goals in most documents, and any statement of when a PRD is done. This
standard adds those going forward rather than rewriting history backwards —
a PRD rewritten after shipping to look like it was planned that way is a
[named anti-pattern][cagan-prd], not an improvement.

## The template

```markdown
# prd-NN — short title

> **Status:** proposed | blessed by <person>, <date> | shipped <date> | superseded by prd-NN

## Problem

What is wrong today, for whom, and what it costs them. No solution here.

## Evidence

Why we believe the problem is real — a dogfood finding, a spike, an operator
report, a measurement. Link it. If the evidence is a research note, commit the
note.

## Success

How we will know this worked. A demoable scenario is acceptable; silence is not.
Prefer something falsifiable over something aspirational.

## Non-goals

What this explicitly does not do. Carries equal weight to the problem — this is
what stops scope arguments mid-build.

## Rulings

## Ruling 1 — <the verdict, as a sentence>

The decision, then why, then how far it extends. Amend a ruling by adding a new
numbered ruling that names the one it changes. Never edit a ruling's number.

## Open questions

What is deliberately unresolved. Say "open, not ruled" rather than leaving
silence to imply agreement.
```

## Where a decision belongs

A ruling decides **product scope and behaviour**, and dies with its PRD. An
[ADR](../adr/README.md) decides **structure that outlives the PRD** — boundaries,
contracts, formats, where authority lives.

When a ruling turns out to be architectural, link to the ADR rather than
restating it. Eleven such decisions were extracted from these PRDs into
`docs/adr/` on 2026-08-06; the PRD text was left intact so existing citations
keep resolving.

## Practice worth knowing

- **Problem before solution.** Every strong template puts it first, and Intercom
  is blunt about the boundary: *"do not add the solution here"* inside the problem
  section.
- **Non-goals carry equal weight to goals.** Standard in Shape Up ("no-gos") and
  Google's design docs ("Goals and Non-Goals").
- **Length is a feature.** Intercom caps a PRD at one printed page — *"if you
  can't fit the problem on a page, you don't understand it well enough."* This
  repo's median is 82 lines, which is already good; don't lose that.
- **Close it out.** The most common failure is a PRD frozen at kickoff while
  reality diverges, with nobody reconciling it. `docs/roadmap.md` is currently
  the only record of what shipped — the `Status` line above exists so a PRD is
  no longer silent about its own fate.

### Anti-patterns

- **Written after the fact** — a document justifying work already decided.
- **PRD-as-spec** — the solution section grows into a functional spec, the "why"
  is lost, and the doc becomes brittle to change.
- **Never closed out** — frozen at kickoff, silently untrue thereafter.
- **Decisions buried in the PRD** — architectural rationale embedded in a product
  document, invisible to the engineer who needs it later. This repo had it; see
  `docs/adr/`.

---

**Further reading:** [Cagan on PRDs][cagan-prd] · [Lenny's template and
examples][lenny] · [Shape Up: write the pitch][shapeup] · [Amazon's working-backwards
PR-FAQ][prfaq] · [Design docs at Google][google] · [Atlassian on
requirements][atlassian]

[cagan-prd]: https://www.svpg.com/discovery-vs-documentation/
[lenny]: https://www.lennysnewsletter.com/p/prds-1-pagers-examples
[shapeup]: https://basecamp.com/shapeup/1.5-chapter-06
[prfaq]: https://workingbackwards.com/resources/working-backwards-pr-faq/
[google]: https://www.industrialempathy.com/posts/design-docs-at-google/
[atlassian]: https://www.atlassian.com/agile/product-management/requirements
