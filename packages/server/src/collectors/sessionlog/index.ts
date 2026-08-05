export { createSessionlogCollector, SESSIONLOG_CAPABILITIES } from './collector.js'
export type { SessionlogCollectorConfig } from './collector.js'
export { parseAssistantLine } from './parse-session-line.js'
export type { AssistantLineFacts, ToolUseFacts } from './parse-session-line.js'
export { parseWorktreePaths } from './parse-worktree-paths.js'
export { readNewLines } from './tail.js'
export type { TailResult } from './tail.js'
export type { LaneLiveness, SessionlogSnapshot } from './types.js'
export { worktreePathToProjectSlug } from './worktree-slug.js'

// --- the transcript-tail state machine (prd15 ruling 1) ---------------------

export {
  agentStatusEmissionFor,
  deriveLaneState,
  needsProcessProbe,
  quietMsOf,
  TRANSCRIPT_STALL_MS,
  TURN_SETTLE_MS,
} from './lane-state.js'
export type {
  AgentStatusEmission,
  AgentStatusEmissionInputs,
  LaneState,
  LaneStateInputs,
  LaneStateReading,
} from './lane-state.js'
export {
  AGENT_COMMANDS,
  createProcProcessProbe,
  defaultProcessProbe,
  UNKNOWN_PROCESS_PROBE,
} from './process-probe.js'
export type { ProcessLiveness, ProcessProbe, ProcProcessProbeOptions } from './process-probe.js'
export { grammarFor, TURN_GRAMMARS } from './turn-grammar.js'
export type { TranscriptCli, TurnEntry, TurnGrammar } from './turn-grammar.js'
export {
  CLAUDE_JSONL_GRAMMAR,
  COMPLETING_STOP_REASONS,
  CONVERSATIONAL_TYPES,
} from './turn-grammar-claude.js'
export { advanceTurnShape, initialTurnShape, isMidTurn, scanTurnShape } from './turn-shape.js'
export type { TurnShape, TurnShapeState } from './turn-shape.js'
