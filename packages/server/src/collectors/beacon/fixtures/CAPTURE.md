# Beacon fixtures

**Hand-written to the ADR-0036 line contract — not a capture.** No emitter
exists yet: `rhizomorph env <lane> --hooks <cli>` is prd-15 ruling 2's later
wave and the `gate.sh` / `dispatch.sh` beacons are prd-17's, so as of #217
there is nothing on any machine to capture. These lines are what a writer
*must* produce, written from `packages/core/src/events/beacon.ts` and read
back by `collector.test.ts` and `parse-beacon-line.test.ts`.

Replace with a real capture when the first emitter lands, and sanitise it the
way every other `CAPTURE.md` in this tree describes: synthetic lane handles,
no home paths, LF line endings (the corpus EOL law sweeps this directory).

`claude-hook.jsonl` — three lines, one per case the tests need:

1. every field present, including `detail`;
2. an extra key (`extra`) the parser ignores and the digest covers;
3. `lane` and `detail` absent — `lane` reads back as `null`.
