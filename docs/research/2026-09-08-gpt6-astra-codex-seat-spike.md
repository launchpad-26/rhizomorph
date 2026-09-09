# Research spike — GPT-6 Astra as a design seat through Codex CLI (2026-09-08)

> **What this is.** A one-evening spike, written the day after the model shipped, to know what
> GPT-6 Astra is, how it is reached from this machine, and whether it earns a seat in this repo's
> workflow — starting with the one job that was to hand: a second visual pass on the lab (prd-54).
> Everything in §1–§3 is read from the sources listed; §4 is what actually happened when the seat
> ran here. Nothing here is a ruling; the operator decides what the seat is for.

## 1 · What it is, as far as the public record says

- **Released 2026-09-03 (limited preview) / 2026-09-04 (paid tiers)**, one day before this spike.
  OpenAI's own page refused an automated fetch (HTTP 403), so the primary claims below are quoted via
  the developer-community announcement, Wikipedia, and two developer write-ups.
- **The claim.** *"Anything you can do on a computer, Astra can do for you. Fast."* State of the art
  claimed for *"computer use, browsing, software engineering, cybersecurity, science, and professional
  work."* Benchmarks named: Agents' Last Exam, AutomationBench, ScreenSpot Pro, FrontierMath Tier 4
  (97.6–98 %), ARC-AGI-3 (99.9 %, on OpenAI's own responses-API harness), Terminal-Bench 4.0 (57.9 %),
  OSWorld 2.0 (72.6 % at ~40 min/task, ~47 % faster than GPT-5.6 Sol), MRCR v2 (96.3 %). It trails
  Claude on Humanity's Last Exam (57.2 % vs 65.0 %) per the DEV write-up.
- **The architecture claim.** A *"recurrent depth"* / looped-transformer reasoning technique; the
  largest training run OpenAI has done (*"more than 100,000 GPUs"*). Safety researchers' stated concern
  is monitorability: the technique *"obscures some or all of the AI's reasoning."*
- **Gating.** Cybersecurity capabilities were limited to programme testers first (*"Daybreak Blue"*
  for defensive use); the public model *"rejects certain prompts in areas such as cybersecurity."*
  Exploit creation is refused at launch. Expect *"occasional pauses where you're asked to review an
  action."*
- **API.** Model id `gpt-6-astra`; context 1,050,000 tokens; max input 922,000; max output 128,000;
  $10 / $50 per million tokens in / out ($1 cached input); a *fast mode* at ~2× price for ~2× speed; a
  surcharge past 272K context (2× in, 1.5× out). Also on Azure and AWS Bedrock.
- **Design-adjacent claims.** *"Follow existing templates for slides, docs, and spreadsheets"* and
  *"match your writing and visual style"*; examples cited are a slide deck kept consistent with a few
  template slides, *"video to code"* and *"3D design"* (no specifics given). Nothing in the record
  describes frontend or UI design as a named strength; the strengths named are agentic execution,
  computer use, long-context coherence, and staying inside task boundaries.

## 2 · How it is reached from this machine

- **Codex CLI.** `~/.codex/config.toml` already carried `model = "gpt-6-astra"` and
  `model_reasoning_effort = "xhigh"` (five levels: low · medium · high · xhigh · max; the
  configuration write-up recommends `high` for ordinary coding and the top two for architecture and
  hard debugging). Plugins enabled: `visualize`, `browser`, `sites`, `documents`, plus the computer-use
  runtime.
- **The version gate, met the hard way.** The installed CLI was 0.145.0; the API answered
  `400 invalid_request_error: The 'gpt-6-astra' model requires a newer version of Codex`. Upgraded to
  0.153.4 (`npm i -g @openai/codex@latest`, 15 s) and the same command ran. A stale-cache warning
  (`failed to load models cache: missing field base_instructions`) appears once on the old version and
  is harmless.
- **Non-interactive form.** `codex exec [OPTIONS] [PROMPT]` with `-C <workdir>`, `--add-dir` for a
  second writable directory, `-s workspace-write`, `-c approval_policy=never` (the write-up recommends
  `untrusted` for pipelines until a team has operational experience; `never` is right only inside a
  directory that holds nothing you mind losing), `-i <image>` (repeatable), `-o <file>` for the last
  message, `--output-schema <json>` for a typed final answer, `--json` for JSONL events,
  `--skip-git-repo-check` outside a repo. **Windows trap:** through the npm `.cmd` shim, an argument
  array is re-parsed by `cmd.exe` and a prompt with spaces splits into words (*"unexpected argument
  'BRIEF.md'"*); pass the whole command line as one pre-quoted string, or feed the prompt on stdin.
- **Context notes.** Astra's Codex integration replaces compaction summaries with *"searchable notes
  across context windows"*; the write-up suggests raising `auto_compact_token_limit` (850,000) and
  disabling `tui.auto_recap` to let it govern. Not exercised in this spike (one-shot run).
- **Async asks.** In Codex, Astra *"can ask asynchronously, continuing work that does not depend on
  your reply and waiting only on consequential decisions."* In `exec` mode with `approval_policy=never`
  there is no one to ask; the brief must carry every decision up front.

## 3 · Use cases worth trying here, and the ones to refuse

**Worth trying**

1. **Second-eye design seats** with a fixed brief, a token file, and a law list — what §4 tests. The
   fit is the *"follow existing templates… match your visual style"* claim, and the fact that a
   design pass is judged by a human against laws that already exist as tests.
2. **Cross-vendor verification** on high-stakes PRs (the factory's codex dialect already does this
   for review; rhizo-review's rule holds: a seat generates findings, a human verifies each).
3. **Computer-use walkthroughs** of the console — the OSWorld figures are the strongest published
   numbers — as a second walker whose screenshots and findings we compare against ours.
4. **Long-record reading.** A million-token context reads a whole session recording or a week of
   retros in one pass. The prd-54 R&D hand (ruling 1: the operator's own agent CLI, spawned as an
   explicit act) could name `codex exec --output-schema` as one of its backends, if the operator's
   CLI is Codex — the schema flag is exactly the shape ruling 3 wants.

**Refuse**

- Letting it author into the repo unsupervised. The design-system laws, claim tests and fences are the
  asset; a foreign author who does not know them produces work that reads well and fails the gate.
- Anything in the cybersecurity-gated region on this repo's behalf — prd-51's transport is the one
  place that comes near it, and the model refuses there by design.
- Treating a benchmark as a reason. Only §4 counts.

## 4 · The seat run — what actually happened

The brief (`BRIEF.md`, kept beside this note's source in the session's scratchpad and reproduced
in prd-54's companion artifact's next revision) asked for three single-file HTML mockups — the
rail-and-stage workspace, a drawing language for the lane canvas, Compare and Metrics density — and a
`NOTES.md`, inside nine laws (no new hue: every colour mapped to a `theme.css` token or a
`scene/palette.ts` constant; never a ranking; every figure with its basis; every state drawn first;
nothing invented beyond the sample data; n organisms per run; mono figures; dark-first;
keyboard-first). Package: the token file, the palette, the charter, the ui-2.0 decisions, prd-54, the
Stage 2 spec HTML, two live screenshots, and three source files for vocabulary.

Three launches on 2026-09-08, each stopped one layer deeper:

| launch | CLI | what stopped it | what it taught |
|---|---|---|---|
| 1 · 21:42 | 0.145.0 | `error: unexpected argument 'BRIEF.md'` | on Windows the npm `.cmd` shim lets `cmd.exe` re-parse an argument array; a prompt with spaces splits. Pass one pre-quoted command line, or the prompt on stdin. |
| 2 · 21:43 | 0.145.0 | `400 invalid_request_error: The 'gpt-6-astra' model requires a newer version of Codex` | the model gates on CLI version; `npm i -g @openai/codex@latest` (0.153.4, 15 s) cleared it. The interactive Codex app and the CLI are separate installs — a working app does not mean a working `exec`. |
| 3 · 21:48 | 0.153.4 | `ERROR: Your workspace is out of credits. Ask your workspace owner to refill in order to continue.` | the seat authenticated, resolved the model, applied `approval_policy=never` and `workspace-write` with both directories, attached both images, and was refused on billing before the first token. |

So, on 2026-09-08, the seat did not run and no mockup existed.

**Launch 4 · 2026-09-10 00:27 · CLI 0.153.4 · credits restored · `-c model_reasoning_effort=medium`
(the operator's instruction: the model is expensive and its output is capped, so not `xhigh`).**
It ran for about fourteen minutes and produced the deliverables — by an unexpected route:

- Codex's Windows sandbox refused to spawn its shell commands (`CreateProcessAsUserW failed: 206`,
  a command-length limit, then a denied Store-Python launch), so the seat could not write files
  through the shell nor verify its own output in a browser. It adapted: it wrote a single
  `build.py` (31 KB of template strings, three `write_text` calls into `out/`, nothing else) plus
  `NOTES.md`, then spent its last minutes hunting for an interpreter the sandbox would run. I ran
  the script myself after reading it, and stopped the seat before it burned more tokens on
  verification it could not perform. Lesson for the next run: give the seat no shell at all
  (`-s read-only` with `--add-dir out/` is not enough — the file tools work, the shell does not);
  ask for the files directly, and say that a build step is not wanted.
- Output: `workspace.html`, `canvas.html`, `compare-metrics.html` (27–29 KB each, 40 physical lines,
  one shared `<style>` and one `<script>` per file, Inter + JetBrains Mono from Google Fonts —
  the theme's own faces), and `NOTES.md` at 396 words with a colour → token table.
- **Law check (executed by my script over the files):** off-palette literals none (15 hex values,
  every one a `theme.css` token or a `scene/palette.ts` constant); ranking words none; the five
  required state strings all present; the one dollar figure outside the sample, `$10.67`, is the sum
  of the four booked costs and is labelled as that arithmetic; native `title=` attributes none.
- **What it drew (reasoned from the source; the Chrome extension was not connected for a visual
  pass):** the canvas as six cubic cords in arm-then-run order off a tissue-coloured root on an
  inset axis, width from the same absolute log scale as `canvas/organism.ts`, reach by measurement
  state, node glyphs by verdict (● passed · × failed · □ not-run · ○ unmeasured), a late fork
  reversing the fan so the root keeps its true x, the failed-to-dispatch arm as a necrotic stub
  named and excluded from the count, one facts panel with `aria-live`, no per-frame work; the
  workspace as rail and pinned stage with real `tablist` / `radiogroup` keyboard paths and frame
  keys 1–5; every position without data saying what was not supplied instead of drawing it.
- **Its three objections to our own Stage 2 specification were all correct** — the late-fork
  acceptance criterion tested the wrong thing, a rail row contradicted its canvas, and the artifact's
  type bypassed the theme — and are fixed in the artifact and prd-54's draft the same day.

Verdict on the use case: **a design seat under a fixed brief and a law list works**, at medium
effort, in one shot, for a few dollars of credits — provided the brief carries every decision and
the output contract asks for files, not a build. The mockups are published beside ours:
canvas https://claude.ai/code/artifact/5c119e0d-89c7-4792-b06b-e792439ef94b · workspace
https://claude.ai/code/artifact/67d5e336-5a29-4cfd-b336-5407504597b7 · compare-metrics
https://claude.ai/code/artifact/e80d5794-1377-4fb0-9dd0-412c962fe4b2. What did verify: the `exec` form is right
(the run header lists workdir, model, provider, approval, sandbox, reasoning effort and a session id);
`--add-dir` widened the sandbox to `out/` as intended; `-i` accepted both images; the credits
refusal arrives on stderr as a plain `ERROR:` line, which a monitor can catch. Cost of the three
attempts: nothing — no tokens were served.

**Next:** the operator's call on which of the seat's choices enter prd-54's wave 5 (the artifact's
§08 names what this note's author would adopt), and a visual pass of the three mockups in a
connected browser to confirm what the source reading says.

## Sources

- OpenAI developer-community announcement: https://community.openai.com/t/introducing-gpt-6-astra-the-most-intelligent-and-aligned-model-in-the-world/1394703
- OpenAI product page (refused automated fetch, 403): https://openai.com/index/gpt-6-astra/
- Wikipedia, *GPT-6 Astra*: https://en.wikipedia.org/wiki/GPT-6_Astra
- Codex Knowledge Base, configuring Astra in Codex CLI: https://codex.danielvaughan.com/2026/09/03/gpt-6-astra-codex-cli-configuration-context-notes-safety/
- DEV Community, a developer's first look: https://dev.to/shresthapandey/gpt-6-astra-a-developers-first-look-at-openais-most-capable-model-yet-2l5d
- CNBC on the rollout and the July incident: https://www.cnbc.com/2026/09/03/open-ai-astra-gpt-6-cyber.html
- 9to5Mac on the ChatGPT and Codex upgrade: https://9to5mac.com/2026/09/04/openai-releasing-major-upgrade-to-chatgpt-and-codex-with-gpt-6-astra-details-here/
- DataCamp, features, benchmarks and pricing: https://www.datacamp.com/blog/gpt-6-astra
