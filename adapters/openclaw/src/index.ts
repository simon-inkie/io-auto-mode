/**
 * io-auto-mode — Exec security classifier for OpenClaw
 *
 * Hook entry point. Evaluates every exec/bash tool call before it runs
 * using a hybrid static + LLM classifier.
 */

export { classify } from '../../../core/classifier.js';
export { evaluateStatic, loadUserPatterns } from '../../../core/static-patterns.js';
export { serialiseTranscript, transcriptToJsonl, buildClassifierInput } from '../../../core/transcript.js';
export { logDecision, setLogPath } from '../../../core/logger.js';
export type {
  ClassifierDecision,
  ClassifierConfig,
  Decision,
  DecisionStage,
  SourceProvenance,
  TranscriptEntry,
  ConversationMessage,
  ModelCallFn,
  ModelCallOptions,
  BenchmarkFixture,
  BenchmarkResult,
  LogEntry,
} from '../../../core/types.js';
export { DEFAULT_CONFIG } from '../../../core/types.js';

// Plugin entry — default export for OpenClaw plugin loader
export { default } from './plugin.js';
