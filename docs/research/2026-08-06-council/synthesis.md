# The council — five chairs, one verdict (2026-08-06)

Convened by the operator: *"what functionality are we missing? what am I
missing that's obvious? what design principles should we follow? … I need a
council of professional thought."* Four independent fable chairs — attention &
trust engineering, distributed systems, product strategy, design philosophy —
each grounded in the repo before reaching outward, plus the conductor's
position filed BEFORE any chair returned (`council/conductor.md`), so
convergence means something.

The full chair notes stand beside this file. This synthesis ranks what they
agree on, assembles the mechanisms they each brought a fragment of, and leaves
the disagreements visible for the operator rather than blended away.

---

## THE MASTER FINDING — five chairs, five disciplines, one sentence

**The causal record is missing its two most important actors: the
instrument's own judgements, and the operator's decisions.**

Each chair arrived at it independently, with different evidence:

- **Conductor** (pre-filed): the gate — fence checks, 12/12 verdicts, holds,
  widenings — runs in untracked scripts and emits zero events; the cohort
  inherits an instrument that cannot see the process that built it.
- **Attention chair**: the SUMMONS has no event — `tide/chapters.ts` admits it
  in its own doc comment — so summons precision, time-in-alarm, flood and
  chattering are uncomputable; exactly what ISA-18.2 audits an alarm system
  on. #133 was only diagnosable because the operator happened to be watching.
- **Systems chair**: the trust chain is 3/5 off-record — gate verdicts,
  dispatch briefs, and fences. Proven consequence: **a recording contains no
  fences at all**, so an off-fence trespass can never be re-derived from the
  record.
- **Principles chair**: prd1's founding insight ("orchestrated setups
  undercount by omitting the orchestrator") recursed one level up — the
  operator is the only unobserved agent. ~150 rulings, the band cut, two
  constitutional amendments: none are events; prd11's causal chain dead-ends
  at a markdown file outside the record.
- **Product chair**: the same hole seen from the jobs side — "you built a
  perfect memory and still write your diary by hand."

**The assembled mechanism** (each fragment already blessed or built):

- New event families, all additive: `summons.raised` / `summons.cleared`,
  `gate.verdict`, `dispatch.brief`, `fence.declared`, `operator.ack` /
  `operator.verdict` / `operator.note`, `session.closed`. Operator events are
  **stamped with the log offset they were decided against** — "who decided,
  when, seeing what," the real answer to the operator's rejection of "a human
  clicked approve."
- Ingestion is prd15's already-blessed beacon mechanism (one-line JSON files
  tailed from the instrument's own dir) — gate.sh and dispatch.sh write
  beacons; the constitution is untouched.
- The principles chair's split governs shape: **sidecar for content, event
  for occurrence** (a pin's text lives in a sidecar; that-a-pin-was-made is
  an event) — the posture labels and prd16 already use.

## SECOND — the record can be trusted forever (integrity cluster)

The systems chair's verified finding upgrades the conductor's hunch:
**recordings rot today, silently.** The event parser is an exact-match union
that silently SKIPS unrecognized lines; `reduce.ts`'s "an unknown future type
must never break a replay" arm is unreachable dead comfort. The instrument
that voices every gap discards evidence wordlessly at the boundary guarding
the permanent record. Plus: live folds arrival order while replay folds
ts-sorted through an order-sensitive reducer (the "same reducer" law covers
the function, not its input order); there is no fsync anywhere; no
`session.closed` event; prd16's rotation crash-ordering is unruled.

Fixes, all small and named: a forward-compatibility law with a **golden era
corpus** — one real recording per era, folded in CI, byte-identical state
forever (the one event-sourcing orthodoxy the repo skipped); a lenient parse
mode that counts and voices unknown events; an identity `upcast()` chokepoint
reserved now; a fold-order fixture and ruling; fsync-on-close and a crash
ordering for rotation. For the forest: the commit DAG is a free, skew-proof
happened-before relation — anchor cross-actor ordering on it, not on clocks.

## THIRD — the operator's memory (the UI dividend)

Once the record is complete, three product moves become selectors-plus-pixels:

1. **The session digest** (`rhizomorph digest` → markdown): the #1 job
   (absence review) served daily; chapter labels are already sentences;
   `SessionListing` has the arithmetic; prd16 bounds the session. A pipe, not
   a panel.
2. **The landing is inspectable**: click a landed/held mark → diffstat +
   patch (read-only `git show`), judge findings docked beside it. The gate is
   the day's highest-stakes decision and the instrument renders no diff
   anywhere. Explicitly NOT an approval queue — the product chair killed the
   review workbench using the repo's own human-seams evidence.
3. **Operator pins**: `{ts, text}` sidecar + occurrence event, rendered in
   the existing mark lane — the one mark the instrument cannot derive, and
   the natural neighbor of the coming fork affordance.

Plus the attention chair's calibration pair: render the instrument's own
false-summons rate beside ALL CLEAR (the two-witness machinery already
computes the grade; it is simply never shown), and `rhizomorph drill` —
replay the staged-pathology corpus with scoring, because
retraining-with-feedback is the only measured fix for the detection collapse
the repo's own research predicts.

## FOURTH — the constitution becomes a document with teeth

The principles chair extracted 22 laws in 5 articles and ruled: yes to
`docs/constitution.md`, **but only with `constitution.test.ts`** — every law
cites its enforcement test or says NONE YET; a test asserts every cited file
exists and every law-test in the tree appears in the doc. Otherwise it is the
second-summary-kept-in-sync that #156 already ruled against. Two argued
divergences worth keeping stated: ALL CLEAR must carry evidence (dark-cockpit
deliberately inverted — inferred sensors deserve less trust than wired ones);
SRE's latency signal declined in code comments. Two silences to close:
saturation (the rate-limit budget named in prd1, never rendered — the wall
has now stalled the fleet three times) and summons-bound-to-remedy (#192's
law, generalized: every alarm names its VERB).

## DISAGREEMENTS LEFT FOR THE OPERATOR (not blended)

1. **Global search**: the conductor accepted it as table stakes; the product
   chair KILLED it (chapter marks + deep links + the digest serve the actual
   jobs; search is a solution shopping for a problem at this scale). Council
   does not resolve chairs against each other — operator's call.
2. **Budgets/alerts on burn**: product chair killed (subscription-flat costs,
   bottom-ranked job); attention chair's "summons rate is itself an alarm"
   partially overlaps. Operator's call whether any budget renders.
3. **`rhizomorph drill`**: novel, evidence-backed, and slightly exotic —
   ship-worthy or a curiosity? Operator's call.
4. **The recorder seam**: systems chair says name it in prd16 (the last cheap
   moment); doing so now costs prd16 scope. Conductor leans yes.

## What the council explicitly credits as already right

Evidence-bearing calm, the dark-cockpit contrast budget, age-banded
insistence ("genuinely ahead of most industrial HMIs" — attention chair);
principles-as-executable-law with self-non-vacuity-asserting greps (the
repo's signature move — principles chair); refusals that are all
action-shaped and correct (product chair); the amendment protocol itself —
read-only amended twice by ADDING a named hand with its own namespace law,
never by weakening (precedent now stronger than either amendment).
