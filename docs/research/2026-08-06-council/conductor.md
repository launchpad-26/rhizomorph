# The conductor's chair — position filed BEFORE reading the council

Written 2026-08-06, before any council note returned, so the synthesis can be
honest about what the council changed. Five hunches, ranked.

## 1. The gate is invisible to the instrument (my sharpest)

The most trust-relevant machinery this project has — fence checks, 12/12 load
verdicts, merges, HOLDS, deliberate widenings — runs in untracked shell
scripts and emits ZERO events. For a product whose stated thesis is the
causal record, the verdicts that decide what enters the repo are outside the
record. A held lane isn't a chapter mark. A widening isn't attributable in
replay. The gate should speak events (`gate.verdict`, additive), fences
should be data the instrument can render, and holds should appear on the
timeline. This also fixes a handover absurdity: the cohort inherits an
instrument that cannot see the process that built it.

## 2. Nothing searches anything

No search over lanes, transcripts, commits, chapters, or time. A data-dense
instrument without search serves only spatial memory. "Jump to when X" /
command palette is table stakes in every adjacent product and absent here.

## 3. Recordings rot without a compatibility law

Events carry no schema version; the record does. The implicit contract is
that every future reducer folds every past recording identically, forever —
nothing states it, nothing tests it. prd16 makes recordings first-class
artifacts, which makes rot a real liability. The law: a pinned corpus of real
recordings, folded by every reducer version, byte-identical state or the
build fails.

## 4. The operator's acts are outside the record

Rulings, blessings, widenings, nudges, gate decisions — the HUMAN half of
causality — live in GitHub comments and a private journal. prd16 just created
the first operator act the instrument records (rotation). The accountability
question the operator himself keeps asking ("responsibility must be real")
wants operator acts as events: who decided, when, seeing what state.

## 5. The instrument watches everything and still makes the operator write the diary

The absence-review job — the #1 ranked job in our own research — ends with
the operator hand-writing a journal entry the instrument already knows the
contents of. A session digest on close (landed / held / cost / the moments
that needed you / what's still open), exported as text from a recording, is
the one-person-company feature hiding in plain sight. prd16's capture work
makes it nearly free.

## Meta-principle I expect the principles chair to find

"One witness is no witness." #133 codified it for lane liveness (pane silence
AND telemetry recency). The conductor then spent a day rediscovering it across
seven watcher false-positives without ever writing it as a law. It should be
a stated principle of the whole system, not a scar on two components.
