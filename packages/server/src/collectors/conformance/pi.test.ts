import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findUnbackedProvidedSignals, type SignalObservations } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { PI_CAPABILITIES } from '../pi/index.js'
import { PI_JSONL_GRAMMAR } from '../pi/grammar.js'
import { observeEventSignals } from './signal-evidence.js'
import { runConformanceSuite } from './suite.js'
import type { ConformanceOrgan } from './types.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pi', 'fixtures')

async function fixtureNames(): Promise<string[]> {
  return (await readdir(fixturesDir)).filter((name) => name.endsWith('.jsonl')).sort()
}

/**
 * pi has no `Collector` and no event-emitting code path at all
 * (`../pi/capabilities.ts`'s header — `EventSource` has no `pi` literal, so
 * `llm.usage`/`llm.cost`/`tool.activity` cannot be emitted in-fence today).
 * `observeEventSignals` is the same generic, shared reducer sessionlog and
 * codex both run their real emitted events through — called here with an
 * empty event list because pi genuinely emits none, which is the honest
 * input, not a stub standing in for one.
 */
function observePi(): SignalObservations {
  return observeEventSignals([])
}

const piOrgan: ConformanceOrgan = {
  name: 'pi',
  capabilities: PI_CAPABILITIES,
  observe: observePi,
  fixtureNames,
}

runConformanceSuite(piOrgan)

describe('conformance suite: pi — the check bites (mutation, executed)', () => {
  it('flips cost to "provided", a signal this organ never backs with a real llm.cost event, and the check goes red', () => {
    // The mutation this repo's own discipline asks for: prove the "declared
    // provided" bar actually bites, not just that PI_CAPABILITIES happens to
    // pass it today. `cost` is the sharpest signal to rig — CAPTURE.md's own
    // finding is that pi's real data would make `provided` tempting the
    // moment a collector exists; this proves the check would still catch it
    // if someone claimed that early, before the EventSource gap is closed.
    const observed = observePi()
    const rigged = { ...PI_CAPABILITIES, cost: { level: 'provided' as const } }
    expect(findUnbackedProvidedSignals(rigged, observed)).toEqual(['cost: declared provided, but no llm.cost event was observed'])

    // Put it back — `rigged` is a fresh object; the real declaration was never mutated.
    expect(findUnbackedProvidedSignals(PI_CAPABILITIES, observed)).toEqual([])
  })

  it('every declared signal is absent, and every one carries both a reason and a remedy', () => {
    for (const [signal, detail] of Object.entries(PI_CAPABILITIES)) {
      if (detail.level === 'provided') {
        // Narrows `detail` to the reason/remedy-carrying branch for the rest
        // of this iteration; also the real assertion that would fail first
        // if a signal were ever declared `provided` (checked again below,
        // explicitly, so a stray `partial` doesn't silently pass either).
        throw new Error(`${signal} should be absent — nothing is emitted yet, got 'provided'`)
      }
      expect(detail.level, `${signal} should be absent, not partial`).toBe('absent')
      expect(detail.reason.length, `${signal}'s reason should say why`).toBeGreaterThan(0)
      expect(detail.remedy?.length ?? 0, `${signal} should name a remedy, not just a reason`).toBeGreaterThan(0)
    }
  })

  it('routes every pi fixture as a raw transcript — none of them is an event-pipeline input (unlike codex\'s OTLP fixtures)', async () => {
    // Unlike codex, which has real OTLP bytes to feed through the shared
    // otel receiver, every pi fixture here is a session-JSONL rollout —
    // there is no parser in fence that turns any of them into a real event.
    const names = await fixtureNames()
    expect(names).toEqual([
      'pi-0.83.0-tail-pending-tool-interrupted.jsonl',
      'pi-0.83.0-task-error.jsonl',
      'pi-0.83.0-tool-call-error.jsonl',
      'pi-0.83.0-tool-call.jsonl',
      'pi-0.83.0-turn-complete.jsonl',
      'pi-0.83.0-write-tool.jsonl',
    ])
  })

  it('the failure/absence outcome is real: a genuine API rejection, not just a filename claiming failure', async () => {
    const text = await readFile(path.join(fixturesDir, 'pi-0.83.0-task-error.jsonl'), 'utf8')
    const lines = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
    const assistantLine = lines.at(-1)
    expect(assistantLine.message.role).toBe('assistant')
    expect(assistantLine.message.stopReason).toBe('error')
    expect(assistantLine.message.errorMessage).toContain('definitely-not-a-real-model-xyz is not a valid model ID')
    // The real turn-shape read on this line: a completed turn, not a truncation.
    expect(PI_JSONL_GRAMMAR.classify(JSON.stringify(assistantLine))).toMatchObject({
      role: 'assistant',
      turnComplete: true,
      opensToolUseIds: [],
    })
  })

  it('the pending-tool-call outcome is real: a genuine interrupted process, ending mid-tool-call, not a hand-truncated slice', async () => {
    const text = await readFile(path.join(fixturesDir, 'pi-0.83.0-tail-pending-tool-interrupted.jsonl'), 'utf8')
    const lines = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
    const lastLine = lines.at(-1)
    expect(lastLine.message.role).toBe('assistant')
    expect(lastLine.message.stopReason).toBe('toolUse')
    const toolCall = lastLine.message.content.find((block: { type: string }) => block.type === 'toolCall')
    expect(toolCall.name).toBe('bash')
    expect(toolCall.arguments.command).toContain('sleep 15')
    // No toolResult line ever follows — the process was killed mid-execution.
    expect(lines.some((l) => l.message?.role === 'toolResult')).toBe(false)
  })
})
