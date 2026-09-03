#!/usr/bin/env bash
# windows-triage.sh — the verdict of the native Windows suite (prd-25 rulings 2
# and 3, #212). Compares vitest's per-file JSON results against the committed
# expected-fail list, .windows-known-failures, PER FILE — never by count.
#
#   usage: scripts/windows-triage.sh <vitest-json-results> <known-failures-list>
#
# The suite step in .github/workflows/windows-suite.yml runs with
# continue-on-error and its exit status is deliberately not the verdict — this
# is. Four categories, and only two of them are red:
#
#   UNEXPECTED FAILURE   failed, not on the list          -> RED
#   expected             failed, on the list              -> reported, every run
#   CANDIDATE FOR REMOVAL  on the list, ran, and passed    -> reported, not red
#   listed but not run   on the list, absent from results -> RED
#
# A count masks a swap (one fixed, one newly broken, same number); a list is
# falsifiable per file, so the comparison below is set difference and nothing
# else. The list is expected-fail, not skip (prd-25 amendment, 2026-08-24):
# every entry is printed on every run, so debt never reads as health.
#
# Before any comparison the list itself is validated — exactly one `measured:`
# provenance line, every entry a tracked test file with one of ruling 3's
# cause classes and an evidence note — and a results file that is missing or
# unparseable is red, because a run that crashed before writing results must
# never read as clean. Pure: same inputs, same output, same exit; it writes
# nothing except an appendix to $GITHUB_STEP_SUMMARY when that is set.
#
# Bash wrapper, node body: the input is JSON and the path normalisation is the
# whole point. Runs the same under Git Bash on the runner and under bash on a
# Mac, which is what lets packages/server/src/windows-suite-law.test.ts drive
# it with synthetic results. Exit 1 on RED, 0 on GREEN, 2 on misuse.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/windows-triage.sh <vitest-json-results> <known-failures-list>" >&2
  exit 2
fi

node - "$1" "$2" <<'NODE_EOF'
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const [resultsPath, listPath] = process.argv.slice(2)

// prd-25 ruling 3's cause classes — six at the ruling, a seventh (fs-semantics)
// by the 2026-09-03 amendment — spelled exactly as the list must spell them. windows-suite-law.test.ts reads this literal out of this file and holds
// the list's own header to it, so the two cannot drift.
const CLASSES = ['path-separator', 'drive-letter', 'procfs', 'line-endings', 'process-signalling', 'temp-dir', 'fs-semantics']
const MEASURED_RE = /^# measured: ([0-9a-f]{40}) node (\d+\.\d+\.\d+) windows-latest (\d{4}-\d{2}-\d{2}) (\S+)$/
const ENTRY_RE = /^(\S+)\s+(\S+)(?:\s+#\s*(.*))?$/
const EVIDENCE_RE = /^evidence:\s*(.+)$/

const lines = []
function say(line) {
  lines.push(line)
  console.log(line)
}

const listViolations = []
let measured = null
const listed = new Map() // file -> { cls, evidence }

// ---- 1. inputs exist and parse ------------------------------------------
let results = null
const inputViolations = []
if (!fs.existsSync(resultsPath)) {
  inputViolations.push(`no vitest results at ${resultsPath} — the suite step produced nothing, so there is no verdict to give`)
} else {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
  } catch (err) {
    inputViolations.push(`vitest results at ${resultsPath} are not JSON: ${err.message.split('\n')[0]}`)
  }
  if (parsed !== undefined) {
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.testResults)) {
      inputViolations.push(`vitest results at ${resultsPath} carry no testResults array — not a vitest JSON report`)
    } else {
      results = parsed.testResults
    }
  }
}

// ---- 2. validate the list, all of it, before comparing anything ----------
if (!fs.existsSync(listPath)) {
  listViolations.push(`no known-failures list at ${listPath}`)
} else {
  let repoRoot = null
  const tracked = (file) => {
    if (repoRoot === null) {
      repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    }
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd: repoRoot, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  const raw = fs.readFileSync(listPath, 'utf8')
  // CRLF tolerated on read: this file is not under .gitattributes' eol pin and
  // Git for Windows may check it out CRLF.
  const listLines = raw.split(/\r?\n/)
  let measuredCount = 0
  listLines.forEach((line, index) => {
    const at = `${listPath}:${index + 1}`
    const text = line.replace(/\s+$/, '')
    if (text.length === 0) return
    if (text.startsWith('#')) {
      if (!/^# measured:/.test(text)) return
      measuredCount += 1
      const m = MEASURED_RE.exec(text)
      if (m === null) {
        listViolations.push(`${at}: malformed measured line — expected "# measured: <40-hex sha> node <major.minor.patch> windows-latest <YYYY-MM-DD> <run URL>", got "${text}"`)
        return
      }
      measured = { sha: m[1], node: m[2], date: m[3], url: m[4], text }
      return
    }
    const e = ENTRY_RE.exec(text)
    if (e === null) {
      listViolations.push(`${at}: not an entry — expected "<repo-relative test file>  <class>  # evidence: <text>", got "${text}"`)
      return
    }
    const [, file, cls, trailer] = e
    if (!/^packages\/.+\.test\.tsx?$/.test(file)) {
      listViolations.push(`${at}: "${file}" is not a packages/ test file (.test.ts or .test.tsx) — the list names test FILES, resolved, never a directory or a prefix`)
    }
    if (!CLASSES.includes(cls)) {
      listViolations.push(`${at}: "${cls}" is not one of prd-25 ruling 3's cause classes (${CLASSES.join(', ')})`)
    }
    const ev = trailer === undefined ? null : EVIDENCE_RE.exec(trailer)
    if (trailer === undefined) {
      listViolations.push(`${at}: no evidence note on "${file}" — an entry nobody can judge is an entry nobody can remove; add "# evidence: <first line of the failure>"`)
    } else if (ev === null || ev[1].trim().length === 0) {
      listViolations.push(`${at}: the trailer on "${file}" must be "# evidence: <text>", got "# ${trailer}"`)
    }
    if (listed.has(file)) {
      listViolations.push(`${at}: "${file}" is listed twice`)
    } else if (!tracked(file)) {
      listViolations.push(`${at}: "${file}" is not a tracked file — a renamed or deleted test cannot sit on the list under its old name`)
    }
    listed.set(file, { cls, evidence: ev === null ? '' : ev[1].trim() })
  })
  if (measuredCount !== 1) {
    listViolations.push(`${listPath}: expected exactly one "# measured:" line, found ${measuredCount}`)
  }
}

function summaryAndExit(counts, red) {
  say(
    `windows-triage: ${counts.unexpected} unexpected · ${counts.expected} expected · ${counts.candidates} removal candidates · ${counts.notRun} listed-not-run · verdict ${red ? 'RED' : 'GREEN'}`,
  )
  process.exit(red ? 1 : 0)
}

const zero = { unexpected: 0, expected: 0, candidates: 0, notRun: 0 }

if (inputViolations.length > 0 || listViolations.length > 0) {
  for (const v of inputViolations) say(`RED: ${v}`)
  for (const v of listViolations) say(`RED: list rejected — ${v}`)
  if (listViolations.length > 0) say('nothing compared: a list that fails its own grammar gives no verdict')
  summaryAndExit(zero, true)
}

say(`measured against ${measured.sha} node ${measured.node} windows-latest ${measured.date} ${measured.url}`)

// ---- 3. normalise every result's file ------------------------------------
// vitest's testResults[].name is absolute, in the platform's separators. Every
// vitest project here lives under packages/* (root vitest.config.ts), so the
// repo-relative name is everything from the LAST "/packages/" onward. Not
// path.relative(cwd, name): that cannot be exercised from a POSIX test with
// Windows-shaped fixtures, and on the runner cwd may be an 8.3 or long form
// of the same directory.
function place(name) {
  const slashed = String(name).replace(/\\/g, '/')
  if (/^packages\//.test(slashed)) return slashed
  const idx = slashed.lastIndexOf('/packages/')
  if (idx === -1) return null
  return slashed.slice(idx + 1)
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/)[0] ?? ''
}

function reasonFor(result) {
  const message = firstLine(result.message)
  if (message.length > 0) return message
  const failing = Array.isArray(result.assertionResults)
    ? result.assertionResults.find((a) => a.status === 'failed')
    : undefined
  if (failing === undefined) return '(no message recorded)'
  const detail = firstLine(Array.isArray(failing.failureMessages) ? failing.failureMessages[0] : '')
  return detail.length > 0 ? `${failing.fullName} — ${detail}` : String(failing.fullName)
}

const ran = new Map() // file -> result
const unplaceable = []
for (const result of results) {
  const file = place(result.name)
  if (file === null) {
    unplaceable.push(String(result.name))
    continue
  }
  ran.set(file, result)
}
if (unplaceable.length > 0) {
  for (const name of unplaceable) say(`RED: cannot place result "${name}" — no /packages/ segment, so it maps to no tracked file`)
  summaryAndExit(zero, true)
}

// ---- 4 & 5. failing set, compared per file --------------------------------
// The JSON reporter's file status is exactly "failed" or "passed" (a file that
// failed to LOAD is "failed" with zero assertionResults and a message), so a
// file that cannot import on Windows is a Windows failure like any other.
const failing = new Map()
for (const [file, result] of ran) {
  if (result.status !== 'passed') failing.set(file, result)
}

const unexpected = []
const expected = []
const candidates = []
const notRun = []
for (const [file, result] of failing) {
  if (listed.has(file)) expected.push({ file, cls: listed.get(file).cls, reason: reasonFor(result) })
  else unexpected.push({ file, reason: reasonFor(result) })
}
for (const [file, entry] of listed) {
  if (!ran.has(file)) notRun.push({ file, cls: entry.cls })
  else if (!failing.has(file)) candidates.push({ file, cls: entry.cls })
}
const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
unexpected.sort(byFile)
expected.sort(byFile)
candidates.sort(byFile)
notRun.sort(byFile)

for (const u of unexpected) {
  say(`UNEXPECTED FAILURE (not on .windows-known-failures): ${u.file}`)
  say(`    ${u.reason}`)
}
for (const e of expected) say(`expected, still failing [${e.cls}]: ${e.file}`)
for (const c of candidates) say(`CANDIDATE FOR REMOVAL (listed, now passes): ${c.file}`)
for (const n of notRun) say(`RED: listed but not run: ${n.file} — a list may not claim a file the suite did not evaluate`)

// ---- 7. the job-page summary, when asked ---------------------------------
const red = unexpected.length > 0 || notRun.length > 0
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = []
  md.push(`## Windows suite triage — ${red ? 'RED' : 'GREEN'}`)
  md.push('')
  md.push(`\`${measured.text.replace(/^# /, '')}\``)
  md.push('')
  const section = (title, items, render) => {
    md.push(`### ${title} (${items.length})`)
    md.push('')
    if (items.length === 0) md.push('- none')
    for (const item of items) md.push(`- ${render(item)}`)
    md.push('')
  }
  section('Unexpected failures — not on the list, RED', unexpected, (u) => `\`${u.file}\` — ${u.reason}`)
  section('Expected, still failing', expected, (e) => `\`${e.file}\` [${e.cls}]`)
  section('Candidates for removal — listed, now passing', candidates, (c) => `\`${c.file}\` [${c.cls}]`)
  section('Listed but not run — RED', notRun, (n) => `\`${n.file}\` [${n.cls}]`)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`)
}

summaryAndExit(
  { unexpected: unexpected.length, expected: expected.length, candidates: candidates.length, notRun: notRun.length },
  red,
)
NODE_EOF
