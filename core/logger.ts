import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClassifierDecision, LogEntry, LogIdentity, SourceProvenance } from './types.js';

const DEFAULT_LOG_PATH = 'memory/auto-mode-log.jsonl';

let logPath = DEFAULT_LOG_PATH;

export function setLogPath(path: string): void {
  logPath = path;
}

/**
 * Log a classifier decision to the JSONL log file.
 * All decisions are logged regardless of outcome.
 *
 * `identity` carries optional adapter-side fields (adapter name,
 * conversation_id, cursor_version, workspace_roots, user_email) that the
 * adapter has access to but core does not. Audits use these to distinguish
 * entries from different runtimes.
 */
export function logDecision(
  command: string,
  result: ClassifierDecision,
  source?: SourceProvenance,
  identity?: LogIdentity,
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    command,
    stage: result.stage,
    decision: result.decision,
    durationMs: result.durationMs,
  };

  if (result.model) entry.model = result.model;
  if (result.reason) entry.reason = result.reason;
  if (result.thinking) entry.thinking = result.thinking;
  if (source) entry.source = source;

  if (identity?.adapter) entry.adapter = identity.adapter;
  if (identity?.conversationId) entry.conversationId = identity.conversationId;
  if (identity?.cursorVersion) entry.cursorVersion = identity.cursorVersion;
  if (identity?.workspaceRoots && identity.workspaceRoots.length > 0) {
    entry.workspaceRoots = identity.workspaceRoots;
  }
  if (identity?.userEmail !== undefined && identity.userEmail !== null) {
    entry.userEmail = identity.userEmail;
  }

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Logging failure must not affect classification.
    // The classifier must still return its decision.
    // In production, this would emit to stderr.
    console.error(`[io-auto-mode] Failed to write log to ${logPath}`);
  }
}
